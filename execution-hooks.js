console.log("[HOOK FILE] execution-hooks.js loaded at:", new Date().toISOString());

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
 * Extrai tempo economizado
 */
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

/**
 * Coleta tokens únicos globalmente
 */
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

    // chave única = totalTokens
    if (total > 0 && !tokenMap.has(total)) {
      tokenMap.set(total, {
        totalTokens: total,
        promptTokens: prompt,
        completionTokens: completion
      });
    }
  }

  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      collectUniqueTokens(value, tokenMap);
    }
  }
}

/**
 * Soma tokens únicos
 */
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

/**
 * Extrai modelo
 */
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
        const resultData = fullRunData?.data?.resultData?.runData || {};
        const startedAt = fullRunData?.startedAt;
        const stoppedAt = fullRunData?.stoppedAt;

        const uniqueTokenMap = new Map();

        let totalMinutesSaved = 0;
        let aiNodeFound = false;
        let aiModel = null;

        for (const [nodeName, nodeRuns] of Object.entries(resultData)) {
          const nodeInfo = workflowData?.nodes?.find(n => n.name === nodeName);
          if (!nodeInfo) continue;

          totalMinutesSaved += extractTimeSaved(nodeRuns);

          const matchesKnownAiNode = AI_NODE_IDENTIFIERS.some(prefix =>
            nodeInfo.type.startsWith(prefix)
          );

          const detectedModel = extractAiModel(nodeRuns);

          // coleta tokens únicos globalmente
          collectUniqueTokens(nodeRuns, uniqueTokenMap);

          const hasAiPayload =
            detectedModel && uniqueTokenMap.size > 0;

          const isAiNode =
            (matchesKnownAiNode && !IGNORED_NODE_TYPES.includes(nodeInfo.type)) ||
            hasAiPayload;

          if (isAiNode) {
            aiNodeFound = true;

            if (!aiModel && detectedModel) {
              aiModel = detectedModel;
            }
          }
        }

        // soma final única
        const tokenStats = sumUniqueTokens(uniqueTokenMap);

        const logData = {
          execution_id: executionId,
          workflow_id: workflowData?.id,
          workflow_name: workflowData?.name,
          status: fullRunData?.status || (fullRunData?.finished ? "success" : "error"),
          finished: fullRunData?.finished || false,
          started_at: startedAt,
          finished_at: stoppedAt,
          duration_ms: startedAt && stoppedAt
            ? new Date(stoppedAt).getTime() - new Date(startedAt).getTime()
            : null,
          mode: fullRunData?.mode,
          node_count: Object.keys(resultData).length,
          error_message: fullRunData?.data?.resultData?.error?.message || null,

          has_ai: aiNodeFound,
          ai_model: aiModel,

          total_tokens: tokenStats.totalTokens,
          prompt_tokens: tokenStats.promptTokens,
          completion_tokens: tokenStats.completionTokens,

          minutes_saved: Math.round(totalMinutesSaved)
        };

        console.log(
          `[HOOK] ID ${executionId} | AI: ${aiNodeFound} | Model: ${aiModel} | Unique Token Blocks: ${uniqueTokenMap.size} | Tokens: ${tokenStats.totalTokens}`
        );

        await logToSupabase(logData);
      }
    ]
  }
};