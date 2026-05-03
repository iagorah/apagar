console.log("[HOOK FILE] execution-hooks.js loaded at:", new Date().toISOString()); // loga carregamento do hook

const SUPABASE_URL = process.env.SUPABASE_URL; // URL do Supabase
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // chave de serviço do Supabase

const AI_NODE_IDENTIFIERS = [ // lista de prefixes de nodes de IA conhecidos
  "@n8n/n8n-nodes-langchain",
  "n8n-nodes-base.openAi",
  "n8n-nodes-base.anthropic",
  "n8n-nodes-base.googlePalm",
  "n8n-nodes-base.awsBedrock"
];

const IGNORED_NODE_TYPES = ["n8n-nodes-base.n8n"]; // nodes ignorados na detecção de IA

// extrai minutos economizados dos metadados dos nodes
function extractTimeSaved(nodeRuns) {
  let totalMinutes = 0;

  if (!Array.isArray(nodeRuns)) return 0;

  for (const run of nodeRuns) {
    const minutes = run.metadata?.timeSaved?.minutes;
    if (minutes !== undefined) {
      totalMinutes += Number(minutes);
    }
  }

  return totalMinutes;
}

// coleta blocos únicos de tokens percorrendo recursivamente o objeto
function collectUniqueTokens(obj, tokenMap) {
  if (!obj || typeof obj !== "object") return;

  let tokenBlock = null;

  if (obj.tokenUsage && typeof obj.tokenUsage === "object") {
    tokenBlock = obj.tokenUsage;
  } else if (obj.token_usage && typeof obj.token_usage === "object") {
    tokenBlock = obj.token_usage;
  }

  if (tokenBlock) {
    const total = Number(tokenBlock.totalTokens || tokenBlock.total_tokens || 0);
    const prompt = Number(tokenBlock.promptTokens || tokenBlock.prompt_tokens || 0);
    const completion = Number(tokenBlock.completionTokens || tokenBlock.completion_tokens || 0);

    if (total > 0 && !tokenMap.has(total)) {
      tokenMap.set(total, { // garante unicidade por totalTokens
        totalTokens: total,
        promptTokens: prompt,
        completionTokens: completion
      });
    }
  }

  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      collectUniqueTokens(value, tokenMap); // recursão
    }
  }
}

// soma os tokens únicos coletados
function sumUniqueTokens(tokenMap) {
  const totals = {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0
  };

  for (const token of tokenMap.values()) {
    totals.totalTokens += token.totalTokens;
    totals.promptTokens += token.promptTokens;
    totals.completionTokens += token.completionTokens;
  }

  return totals;
}

// tenta extrair o modelo de IA recursivamente
function extractAiModel(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (obj.ai_model) return obj.ai_model;
  if (obj.model) return obj.model;
  if (obj.model_name) return obj.model_name;
  if (obj.modelId) return obj.modelId;

  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      const found = extractAiModel(value);
      if (found) return found;
    }
  }

  return null;
}

// extrai o tipo de trigger a partir do triggerNode do n8n
function extractTriggerType(fullRunData) {
  const rawType =
    fullRunData?.data?.executionData?.runtimeData?.triggerNode?.type;

  if (!rawType) return null;

  const lastSegment = rawType.split(".").pop(); // pega último trecho

  return lastSegment
    .replace(/Trigger$/i, "") // remove Trigger
    .toLowerCase(); // normaliza
}

// envia dados para o Supabase
async function logToSupabase(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/n8n_execution_logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      console.error("[HOOK] Supabase insert failed:", await response.text());
    }
  } catch (error) {
    console.error("[HOOK] Supabase error:", error.message);
  }
}

module.exports = {
  workflow: {
    postExecute: [
      async function (fullRunData, workflowData, executionId) {
        const resultData = fullRunData?.data?.resultData?.runData || {}; // dados de execução por node
        const startedAt = fullRunData?.startedAt; // início da execução
        const stoppedAt = fullRunData?.stoppedAt; // fim da execução

        const uniqueTokenMap = new Map(); // mapa de tokens únicos

        let totalMinutesSaved = 0; // acumulador de tempo economizado
        let aiNodeFound = false; // flag de presença de IA
        let aiModel = null; // modelo detectado

        // percorre todos os nodes executados
        for (const [nodeName, nodeRuns] of Object.entries(resultData)) {
          const nodeInfo = workflowData?.nodes?.find(n => n.name === nodeName);
          if (!nodeInfo) continue;

          totalMinutesSaved += extractTimeSaved(nodeRuns); // soma tempo economizado

          const matchesKnownAiNode = AI_NODE_IDENTIFIERS.some(prefix =>
            nodeInfo.type.startsWith(prefix)
          );

          const detectedModel = extractAiModel(nodeRuns); // tenta extrair modelo

          collectUniqueTokens(nodeRuns, uniqueTokenMap); // coleta tokens únicos

          const hasAiPayload = detectedModel && uniqueTokenMap.size > 0; // valida payload de IA

          const isAiNode =
            (matchesKnownAiNode && !IGNORED_NODE_TYPES.includes(nodeInfo.type)) ||
            hasAiPayload;

          if (isAiNode) {
            aiNodeFound = true;

            if (!aiModel && detectedModel) {
              aiModel = detectedModel; // salva primeiro modelo encontrado
            }
          }
        }

        const tokenStats = sumUniqueTokens(uniqueTokenMap); // soma final de tokens

        const triggerType = extractTriggerType(fullRunData); // extrai tipo do trigger

        const logData = {
          execution_id: executionId,
          workflow_id: workflowData?.id,
          workflow_name: workflowData?.name,

          status: fullRunData?.status || (fullRunData?.finished ? "success" : "error"), // status final
          finished: fullRunData?.finished || false,

          started_at: startedAt,
          finished_at: stoppedAt,

          duration_ms: startedAt && stoppedAt
            ? new Date(stoppedAt).getTime() - new Date(startedAt).getTime()
            : null, // duração total

          mode: fullRunData?.mode, // modo de execução (manual, trigger, etc)

          trigger_type: triggerType, // tipo do trigger normalizado

          node_count: Object.keys(resultData).length, // quantidade de nodes executados

          error_message: fullRunData?.data?.resultData?.error?.message || null, // erro se houver

          has_ai: aiNodeFound, // flag de IA
          ai_model: aiModel, // modelo de IA detectado

          total_tokens: tokenStats.totalTokens,
          prompt_tokens: tokenStats.promptTokens,
          completion_tokens: tokenStats.completionTokens,

          minutes_saved: Math.round(totalMinutesSaved) // tempo economizado arredondado
        };

        console.log(
          `[HOOK] ID ${executionId} | Trigger: ${triggerType} | AI: ${aiNodeFound} | Model: ${aiModel} | Tokens: ${tokenStats.totalTokens}`
        ); // log resumido

        await logToSupabase(logData); // envia pro banco
      }
    ]
  }
};