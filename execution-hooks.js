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
 * Extrai tokens com deduplicação
 */
function extractTokenUsage(
  obj,
  totals = {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0
  },
  seen = new Set()
) {
  if (!obj || typeof obj !== "object") return totals;

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

    const signature = `${total}-${prompt}-${completion}`;

    if (!seen.has(signature)) {
      seen.add(signature);

      totals.totalTokens += total;
      totals.promptTokens += prompt;
      totals.completionTokens += completion;
    }
  }

  const total = obj.totalTokens || obj.total_tokens;
  const prompt = obj.promptTokens || obj.prompt_tokens;
  const completion = obj.completionTokens || obj.completion_tokens;

  if (total !== undefined || prompt !== undefined || completion !== undefined) {
    const t = Number(total || 0);
    const p = Number(prompt || 0);
    const c = Number(completion || 0);

    const signature = `${t}-${p}-${c}`;

    if (!seen.has(signature)) {
      seen.add(signature);

      totals.totalTokens += t;
      totals.promptTokens += p;
      totals.completionTokens += c;
    }
  }

  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      extractTokenUsage(value, totals, seen);
    }
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

        let tokenStats = {
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0
        };

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
          const detectedTokens = extractTokenUsage(nodeRuns);

          const hasAiPayload =
            detectedModel &&
            (
              detectedTokens.totalTokens > 0 ||
              detectedTokens.promptTokens > 0 ||
              detectedTokens.completionTokens > 0
            );

          const isAiNode =
            (matchesKnownAiNode && !IGNORED_NODE_TYPES.includes(nodeInfo.type)) ||
            hasAiPayload;

          if (isAiNode) {
            aiNodeFound = true;

            tokenStats.totalTokens += detectedTokens.totalTokens;
            tokenStats.promptTokens += detectedTokens.promptTokens;
            tokenStats.completionTokens += detectedTokens.completionTokens;

            if (!aiModel && detectedModel) {
              aiModel = detectedModel;
            }
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

          duration_ms: startedAt && stoppedAt
            ? new Date(stoppedAt).getTime() - new Date(startedAt).getTime()
            : null,

          mode: fullRunData?.mode,
          node_count: Object.keys(resultData).length,

          error_message:
            fullRunData?.data?.resultData?.error?.message || null,

          has_ai: aiNodeFound,
          ai_model: aiModel,

          total_tokens: tokenStats.totalTokens,
          prompt_tokens: tokenStats.promptTokens,
          completion_tokens: tokenStats.completionTokens,

          minutes_saved: Math.round(totalMinutesSaved)
        };

        console.log(
          `[HOOK] ID ${executionId} | AI: ${aiNodeFound} | Model: ${aiModel} | Tokens: ${tokenStats.totalTokens} | Minutes Saved: ${logData.minutes_saved}`
        );

        await logToSupabase(logData);
      }
    ]
  }
};