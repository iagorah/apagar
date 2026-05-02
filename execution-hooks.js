console.log("[HOOK FILE] execution-hooks.js loaded at:", new Date().toISOString());

// Configurações do Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Prefixos de nós oficiais de IA do n8n para evitar capturar textos de outros nós[cite: 2, 4]
const AI_NODE_IDENTIFIERS = [
  "@n8n/n8n-nodes-langchain", 
  "n8n-nodes-base.openAi",
  "n8n-nodes-base.anthropic",
  "n8n-nodes-base.googlePalm",
  "n8n-nodes-base.awsBedrock"
];

const IGNORED_NODE_TYPES = ["n8n-nodes-base.n8n"];

/**
 * Extrai tokens e identifica o modelo de IA.
 * Implementa lógica de "encontrou-parou" para evitar somas duplicadas.
 */
function extractAiDetails(obj, totals, aiInfo) {
  if (!obj || typeof obj !== "object") return;

  // 1. Caso Especial: Exemplo 6 (Dados vindos de API externa como Windmill)[cite: 5]
  if (obj.result && obj.result.token_usage) {
    const usage = obj.result.token_usage;
    totals.totalTokens += Number(usage.total_tokens || 0);
    totals.promptTokens += Number(usage.prompt_tokens || 0);
    totals.completionTokens += Number(usage.completion_tokens || 0);
    if (obj.result.ai_model) aiInfo.model = obj.result.ai_model;[cite: 5]
    return; // Para a recursão neste ramo para evitar duplicidade
  }

  // 2. Caso Padrão: Nós Nativos (objeto tokenUsage)[cite: 2, 4]
  if (obj.tokenUsage && typeof obj.tokenUsage === "object") {
    totals.totalTokens += Number(obj.tokenUsage.totalTokens || obj.tokenUsage.total_tokens || 0);
    totals.promptTokens += Number(obj.tokenUsage.promptTokens || obj.tokenUsage.prompt_tokens || 0);
    totals.completionTokens += Number(obj.tokenUsage.completionTokens || obj.tokenUsage.completion_tokens || 0);
    return; // Para a recursão para não somar os campos internos novamente
  }

  // 3. Captura do nome do modelo nos metadados ou opções do nó
  if (obj.model || obj.modelName) {
    aiInfo.model = obj.model || obj.modelName;
  }

  // Busca recursiva nos demais campos (sub-runs, itens, etc)[cite: 4]
  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      extractAiDetails(value, totals, aiInfo);
    }
  }
}

/**
 * Extrai o tempo economizado (minutesSaved) dos metadados da execução[cite: 3].
 */
function extractMinutesSaved(nodeRuns) {
  let totalMinutes = 0;
  if (!Array.isArray(nodeRuns)) return 0;

  for (const run of nodeRuns) {
    const minutes = run.metadata?.timeSaved?.minutes;[cite: 3]
    if (minutes !== undefined) {
      totalMinutes += Number(minutes);
    }
  }
  return totalMinutes;
}

async function logToSupabase(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/n8n_execution_logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(data),
    });
    if (!response.ok) console.error("[HOOK] Supabase Error:", await response.text());
  } catch (error) {
    console.error("[HOOK] Fetch Error:", error.message);
  }
}

module.exports = {
  workflow: {
    postExecute: [
      async function (fullRunData, workflowData, executionId) {
        const resultData = fullRunData?.data?.resultData?.runData || {};
        const startedAt = fullRunData?.startedAt;
        const stoppedAt = fullRunData?.stoppedAt;

        let tokenStats = { totalTokens: 0, promptTokens: 0, completionTokens: 0 };
        let aiInfo = { model: "N/A" };
        let totalMinutesSaved = 0;
        let aiNodeFound = false;

        for (const [nodeName, nodeRuns] of Object.entries(resultData)) {
          const nodeInfo = workflowData?.nodes?.find(n => n.name === nodeName);
          if (!nodeInfo) continue;

          // Soma tempo economizado de qualquer nó que tenha a informação[cite: 3]
          totalMinutesSaved += extractMinutesSaved(nodeRuns);

          // Verifica se o nó é IA oficial ou uma chamada customizada (Exemplo 6)
          const isAiNode = AI_NODE_IDENTIFIERS.some(p => nodeInfo.type.startsWith(p)) || 
                           nodeName.includes("TTS") || nodeName.includes("AI Agent");

          if (isAiNode && !IGNORED_NODE_TYPES.includes(nodeInfo.type)) {
            aiNodeFound = true;
            extractAiDetails(nodeRuns, tokenStats, aiInfo);
          }
        }

        const logData = {
          execution_id: executionId,
          workflow_id: workflowData?.id,
          workflow_name: workflowData?.name,
          status: fullRunData?.status || (fullRunData?.finished ? "success" : "error"),
          finished: fullRunData?.finished || false,
          started_at: startedAt,
          finished_at: stoppedAt,
          duration_ms: startedAt && stoppedAt ? new Date(stoppedAt).getTime() - new Date(startedAt).getTime() : null,
          mode: fullRunData?.mode,
          node_count: Object.keys(resultData).length,
          error_message: fullRunData?.data?.resultData?.error?.message || null,

          has_ai: aiNodeFound,
          ai_model: aiInfo.model,
          total_tokens: tokenStats.totalTokens,
          prompt_tokens: tokenStats.promptTokens,
          completion_tokens: tokenStats.completionTokens,

          // Arredonda para inteiro antes de salvar[cite: 3]
          minutes_saved: Math.round(totalMinutesSaved)
        };

        console.log(`[HOOK] Exec: ${executionId} | Model: ${logData.ai_model} | Tokens: ${logData.total_tokens} | Min: ${logData.minutes_saved}`);
        await logToSupabase(logData);
      },
    ],
  },
};