console.log("[HOOK FILE] execution-hooks.js loaded at:", new Date().toISOString());

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const AI_NODE_IDENTIFIERS = [
  "@n8n/n8n-nodes-langchain",
  "n8n-nodes-base.openAi",
  "n8n-nodes-base.anthropic",
  "n8n-nodes-base.googlePalm",
  "n8n-nodes-base.awsBedrock"
];

const IGNORED_NODE_TYPES = ["n8n-nodes-base.n8n"];

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

function extractTokenUsage(obj, totals = { totalTokens: 0, promptTokens: 0, completionTokens: 0 }) {
  if (!obj || typeof obj !== "object") return totals;

  if (obj.tokenUsage && typeof obj.tokenUsage === "object") {
    totals.totalTokens += Number(obj.tokenUsage.totalTokens || obj.tokenUsage.total_tokens || 0);
    totals.promptTokens += Number(obj.tokenUsage.promptTokens || obj.tokenUsage.prompt_tokens || 0);
    totals.completionTokens += Number(obj.tokenUsage.completionTokens || obj.tokenUsage.completion_tokens || 0);
  }

  const total = obj.totalTokens || obj.total_tokens;
  const prompt = obj.promptTokens || obj.prompt_tokens;
  const completion = obj.completionTokens || obj.completion_tokens;

  if (total !== undefined || prompt !== undefined || completion !== undefined) {
    totals.totalTokens += Number(total || 0);
    totals.promptTokens += Number(prompt || 0);
    totals.completionTokens += Number(completion || 0);
  }

  for (const value of Object.values(obj)) {
    if (typeof value === "object") extractTokenUsage(value, totals);
  }

  return totals;
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
    if (!response.ok) console.error("[HOOK] Supabase insert failed:", await response.text());
  } catch (error) {
    console.error("[HOOK] Supabase error:", error.message);
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
        let totalMinutesSaved = 0;
        let aiNodeFound = false;

        for (const [nodeName, nodeRuns] of Object.entries(resultData)) {
          const nodeInfo = workflowData?.nodes?.find(n => n.name === nodeName);
          if (!nodeInfo) continue;

          // 1. Captura Minutes Saved (Independente de ser IA ou não)[cite: 3]
          totalMinutesSaved += extractTimeSaved(nodeRuns);

          // 2. Captura Tokens (Apenas se for nó de IA)
          const isAiNode = AI_NODE_IDENTIFIERS.some(prefix => nodeInfo.type.startsWith(prefix));
          if (isAiNode && !IGNORED_NODE_TYPES.includes(nodeInfo.type)) {
            aiNodeFound = true;
            const nodeTokens = extractTokenUsage(nodeRuns);
            tokenStats.totalTokens += nodeTokens.totalTokens;
            tokenStats.promptTokens += nodeTokens.promptTokens;
            tokenStats.completionTokens += nodeTokens.completionTokens;
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
          total_tokens: tokenStats.totalTokens,
          prompt_tokens: tokenStats.promptTokens,
          completion_tokens: tokenStats.completionTokens,

          // Novo campo: Minutes Saved arredondado para inteiro[cite: 3]
          minutes_saved: Math.round(totalMinutesSaved)
        };

        console.log(`[HOOK] ID ${executionId} | Minutes Saved: ${logData.minutes_saved} | AI: ${aiNodeFound}`);
        await logToSupabase(logData);
      },
    ],
  },
};