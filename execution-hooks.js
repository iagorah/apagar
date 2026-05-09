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

/* ================================
   TIME SAVED
================================ */

function extractDynamicTimeSaved(nodeRuns) {
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

function extractTimeSaved(fullRunData, workflowData, resultData) {
  const workflowSettings = workflowData?.settings || {};
  const mode = workflowSettings.timeSavedMode;

  // FIXED
  if (mode === "fixed") {
    const executionSucceeded =
      fullRunData?.finished === true &&
      (fullRunData?.status === "success" || !fullRunData?.status);

    if (executionSucceeded) {
      return Number(workflowSettings.timeSavedPerExecution || 0);
    }

    return 0;
  }

  // DYNAMIC (default)
  let totalMinutes = 0;

  for (const nodeRuns of Object.values(resultData || {})) {
    totalMinutes += extractDynamicTimeSaved(nodeRuns);
  }

  return totalMinutes;
}

/* ================================
   TOKEN DETECTION
================================ */

function normalizeTokenBlock(block) {
  if (!block || typeof block !== "object") return null;

  const prompt = Number(
    block.promptTokens ??
    block.prompt_tokens ??
    block.inputTokens ??
    block.input_tokens ??
    0
  );

  const completion = Number(
    block.completionTokens ??
    block.completion_tokens ??
    block.outputTokens ??
    block.output_tokens ??
    0
  );

  const total = Number(
    block.totalTokens ??
    block.total_tokens ??
    block.total ??
    (prompt + completion)
  );

  if (total <= 0 && prompt <= 0 && completion <= 0) return null;

  return {
    totalTokens: total,
    promptTokens: prompt,
    completionTokens: completion
  };
}

function looksLikeTokenUsage(obj) {
  if (!obj || typeof obj !== "object") return false;

  const keys = Object.keys(obj);

  return (
    keys.some(k => /token/i.test(k)) &&
    keys.some(k => /(prompt|completion|input|output|total)/i.test(k))
  );
}

function collectUniqueTokens(obj, tokenMap) {
  if (!obj || typeof obj !== "object") return;

  let tokenBlock = null;

  const candidates = [
    obj.tokenUsage,
    obj.token_usage,
    obj.tokenUsageEstimate,
    obj.token_usage_estimate,
    obj.usage,
    obj.usage_metadata
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTokenBlock(candidate);

    if (normalized) {
      tokenBlock = normalized;
      break;
    }
  }

  if (!tokenBlock && looksLikeTokenUsage(obj)) {
    tokenBlock = normalizeTokenBlock(obj);
  }

  if (tokenBlock) {
    const fingerprint =
      `${tokenBlock.totalTokens}-${tokenBlock.promptTokens}-${tokenBlock.completionTokens}`;

    if (!tokenMap.has(fingerprint)) {
      tokenMap.set(fingerprint, tokenBlock);
    }
  }

  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      collectUniqueTokens(value, tokenMap);
    }
  }
}

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

/* ================================
   MODEL DETECTION
================================ */

function extractAiModel(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (obj.model?.value && typeof obj.model.value === "string") {
    return obj.model.value;
  }

  if (typeof obj.ai_model === "string") return obj.ai_model;
  if (typeof obj.model === "string") return obj.model;
  if (typeof obj.model_name === "string") return obj.model_name;
  if (typeof obj.modelId === "string") return obj.modelId;

  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      const found = extractAiModel(value);
      if (found) return found;
    }
  }

  return null;
}

/* ================================
   TRIGGER
================================ */

function extractTriggerType(fullRunData) {
  const rawType =
    fullRunData?.data?.executionData?.runtimeData?.triggerNode?.type;

  if (!rawType) return null;

  const lastSegment = rawType.split(".").pop();

  return lastSegment
    .replace(/Trigger$/i, "")
    .toLowerCase();
}

/* ================================
   SUPABASE
================================ */

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

/* ================================
   MAIN HOOK
================================ */

module.exports = {
  workflow: {
    postExecute: [
      async function (fullRunData, workflowData, executionId) {
        const resultData = fullRunData?.data?.resultData?.runData || {};
        const startedAt = fullRunData?.startedAt;
        const stoppedAt = fullRunData?.stoppedAt;

        const uniqueTokenMap = new Map();

        let aiNodeFound = false;
        let aiModel = null;

        for (const [nodeName, nodeRuns] of Object.entries(resultData)) {
          const nodeInfo = workflowData?.nodes?.find(
            n => n.name === nodeName
          );

          if (!nodeInfo) continue;

          const matchesKnownAiNode = AI_NODE_IDENTIFIERS.some(prefix =>
            nodeInfo.type.startsWith(prefix)
          );

          const detectedModel = extractAiModel(nodeRuns);

          collectUniqueTokens(nodeRuns, uniqueTokenMap);

          const hasRealAiExecution =
            matchesKnownAiNode &&
            (detectedModel || uniqueTokenMap.size > 0);

          if (
            hasRealAiExecution &&
            !IGNORED_NODE_TYPES.includes(nodeInfo.type)
          ) {
            aiNodeFound = true;

            if (!aiModel && detectedModel) {
              aiModel = detectedModel;
            }
          }
        }

        const totalMinutesSaved = extractTimeSaved(
          fullRunData,
          workflowData,
          resultData
        );

        const tokenStats = sumUniqueTokens(uniqueTokenMap);
        const triggerType = extractTriggerType(fullRunData);

        const logData = {
          execution_id: executionId,
          workflow_id: workflowData?.id,
          workflow_name: workflowData?.name,

          status:
            fullRunData?.status ||
            (fullRunData?.finished ? "success" : "error"),

          finished: fullRunData?.finished || false,

          started_at: startedAt,
          finished_at: stoppedAt,

          duration_ms:
            startedAt && stoppedAt
              ? new Date(stoppedAt).getTime() -
                new Date(startedAt).getTime()
              : null,

          mode: fullRunData?.mode,
          trigger_type: triggerType,

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
          `[HOOK] ID ${executionId} | Trigger: ${triggerType} | AI: ${aiNodeFound} | Model: ${aiModel} | Tokens: ${tokenStats.totalTokens} | Minutes Saved: ${totalMinutesSaved}`
        );

        await logToSupabase(logData);
      }
    ]
  }
};