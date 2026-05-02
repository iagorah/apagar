console.log("[HOOK FILE] execution-hooks.js loaded at:", new Date().toISOString());

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/**
 * Prefixos de tipos de nós que são oficialmente de IA no n8n.
 * Isso garante que não capturaremos campos "total_tokens" vindos de bases de dados ou outros nós.
 */
const AI_NODE_IDENTIFIERS = [
  "@n8n/n8n-nodes-langchain", // Cobre Agentes, Chains e Models novos
  "n8n-nodes-base.openAi",     // Nó legado OpenAI
  "n8n-nodes-base.anthropic",  // Nó legado Anthropic
  "n8n-nodes-base.googlePalm", // Nó legado Google
  "n8n-nodes-base.awsBedrock"  // Nó legado AWS
];

// Nodes técnicos que devem ser ignorados na análise
const IGNORED_NODE_TYPES = [
  "n8n-nodes-base.n8n"
];

/**
 * Extrai o tempo economizado dos metadados do nó
 */
function extractTimeSaved(nodeRuns) {
  let totalMinutes = 0;
  if (!Array.isArray(nodeRuns)) return 0;

  for (const run of nodeRuns) {
    // No exemplo, o dado está em metadata.timeSaved.minutes[cite: 3]
    const minutes = run.metadata?.timeSaved?.minutes;
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

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[HOOK] Supabase insert failed:", errorText);
    }
  } catch (error) {
    console.error("[HOOK] Supabase error:", error.message);
  }
}

function extractTokenUsage(obj, totals = { totalTokens: 0, promptTokens: 0, completionTokens: 0 }) {
  if (!obj || typeof obj !== "object") return totals;

  // 1. Se encontrar o objeto estruturado, processa e para a descida neste ramo
  if (obj.tokenUsage && typeof obj.tokenUsage === "object") {
    totals.totalTokens += Number(obj.tokenUsage.totalTokens || obj.tokenUsage.total_tokens || 0);
    totals.promptTokens += Number(obj.tokenUsage.promptTokens || obj.tokenUsage.prompt_tokens || 0);
    totals.completionTokens += Number(obj.tokenUsage.completionTokens || obj.tokenUsage.completion_tokens || 0);
    
    // IMPORTANTE: Retornamos aqui para não re-processar os campos individuais dentro do próprio tokenUsage
    return totals; 
  }

  // 2. Se não tem tokenUsage, mas tem os campos soltos no nível atual
  const total = obj.totalTokens || obj.total_tokens;
  const prompt = obj.promptTokens || obj.prompt_tokens;
  const completion = obj.completionTokens || obj.completion_tokens;

  if (total !== undefined || prompt !== undefined || completion !== undefined) {
    totals.totalTokens += Number(total || 0);
    totals.promptTokens += Number(prompt || 0);
    totals.completionTokens += Number(completion || 0);
    // Também paramos aqui para evitar duplicidade em campos aninhados idênticos
    return totals;
  }

  // 3. Continua a busca nos filhos (apenas se não encontrou nada no nível atual)
  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      extractTokenUsage(value, totals);
    }
  }

  return totals;
}

module.exports = {
  workflow: {
    postExecute: [
      async function (fullRunData, workflowData, executionId) {
        const resultData = fullRunData?.data?.resultData?.runData || {};
        const startedAt = fullRunData?.startedAt;
        const stoppedAt = fullRunData?.stoppedAt;

        let tokenStats = { totalTokens: 0, promptTokens: 0, completionTokens: 0 };
        let totalMinutesSaved = 0;
        let aiNodeFound = false;

        // Analisa cada nó executado no workflow
        for (const [nodeName, nodeRuns] of Object.entries(resultData)) {
          const nodeInfo = workflowData?.nodes?.find(n => n.name === nodeName);
          if (!nodeInfo) continue;

          // Captura Minutes Saved (Independente de ser IA ou não)
          totalMinutesSaved += extractTimeSaved(nodeRuns);
          
          // Validação: O nó é um nó de IA oficial?
          const isAiNode = AI_NODE_IDENTIFIERS.some(prefix => nodeInfo.type.startsWith(prefix));
          
          // Se não for nó de IA e não estiver na lista de ignorados, pulamos a extração de tokens
          if (!isAiNode || IGNORED_NODE_TYPES.includes(nodeInfo.type)) {
            continue;
          }

          aiNodeFound = true;
          const nodeTokens = extractTokenUsage(nodeRuns);
          
          tokenStats.totalTokens += nodeTokens.totalTokens;
          tokenStats.promptTokens += nodeTokens.promptTokens;
          tokenStats.completionTokens += nodeTokens.completionTokens;
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
          
          // Agora has_ai só é true se um nó de IA real foi disparado
          has_ai: aiNodeFound,
          total_tokens: tokenStats.totalTokens,
          prompt_tokens: tokenStats.promptTokens,
          completion_tokens: tokenStats.completionTokens,
          
          minutes_saved: Math.round(totalMinutesSaved),
        };

        console.log(`[HOOK] Post-Execute ID ${executionId} | AI: ${aiNodeFound} | Tokens: ${tokenStats.totalTokens}`);
        await logToSupabase(logData);
      },
    ],
  },
};