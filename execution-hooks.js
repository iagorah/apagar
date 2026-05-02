/**
 * n8n External Hooks - PowerOtimiza
 * Captura: Logs, IA (Tokens/Modelos) e Tempo Economizado.
 */

console.log("[HOOK FILE] execution-hooks.js loaded at:", new Date().toISOString());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Prefixos de nós oficiais de IA[cite: 2, 4]
const AI_NODE_IDENTIFIERS = [
  "@n8n/n8n-nodes-langchain", 
  "n8n-nodes-base.openAi",
  "n8n-nodes-base.anthropic",
  "n8n-nodes-base.googlePalm",
  "n8n-nodes-base.awsBedrock"
];

const IGNORED_NODE_TYPES = ["n8n-nodes-base.n8n"];

/**
 * Extração de IA com proteção contra duplicidade[cite: 1, 4]
 */
function extractAiDetails(obj, totals, aiInfo) {
  if (!obj || typeof obj !== "object" || obj === null) return;

  // 1. Suporte para retornos customizados (Exemplo 6)[cite: 5]
  if (obj.result && obj.result.token_usage) {
    const usage = obj.result.token_usage;
    totals.totalTokens += Number(usage.total_tokens || 0);
    totals.promptTokens += Number(usage.prompt_tokens || 0);
    totals.completionTokens += Number(usage.completion_tokens || 0);
    if (obj.result.ai_model) {
      aiInfo.model = obj.result.ai_model;[cite: 5]
    }
    return; 
  }

  // 2. Suporte para nós nativos (tokenUsage)[cite: 2, 4]
  if (obj.tokenUsage && typeof obj.tokenUsage === "object") {
    totals.totalTokens += Number(obj.tokenUsage.totalTokens || obj.tokenUsage.total_tokens || 0);
    totals.promptTokens += Number(obj.tokenUsage.promptTokens || obj.tokenUsage.prompt_tokens || 0);
    totals.completionTokens += Number(obj.tokenUsage.completionTokens || obj.tokenUsage.completion_tokens || 0);
    return;
  }

  // 3. Captura do nome do modelo[cite: 4]
  if (obj.model || obj.modelName) {
    aiInfo.model = obj.model || obj.modelName;
  }

  // Recursão protegida
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (typeof value === "object" && value !== null) {
        extractAiDetails(value, totals, aiInfo);
      }
    }
  }
}

/**
 * Captura tempo economizado (metadata)[cite: 3]
 */
function extractMinutesSaved(nodeRuns) {
  let totalMinutes = 0;
  if (!Array.isArray(nodeRuns)) return 0;

  for (let i = 0; i < nodeRuns.length; i++) {
    const run = nodeRuns[i];
    const minutes = (run.metadata && run.metadata.timeSaved) ? run.metadata.timeSaved.minutes : undefined;[cite: 3]
    if (minutes !== undefined) {
      totalMinutes += Number(minutes);
    }
  }
  return totalMinutes;
}

async function logToSupabase(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const response = await fetch(SUPABASE_URL + "/rest/v1/n8n_execution_logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const err = await response.text();
      console.error("[HOOK] Supabase Error:", err);
    }
  } catch (error) {
    console.error("[HOOK] Fetch Error:", error.message);
  }
}

module.exports = {
  workflow: {
    postExecute: [
      async function (fullRunData, workflowData, executionId) {
        try {
          const runData = (fullRunData.data && fullRunData.data.resultData) ? fullRunData.data.resultData.runData || {} : {};
          const startedAt = fullRunData.startedAt;
          const stoppedAt = fullRunData.stoppedAt;

          let tokenStats = { totalTokens: 0, promptTokens: 0, completionTokens: 0 };
          let aiInfo = { model: "N/A" };
          let totalMinutesSaved = 0;
          let aiNodeFound = false;

          for (const nodeName in runData) {
            const nodeRuns = runData[nodeName];
            const nodeInfo = (workflowData.nodes) ? workflowData.nodes.find(function(n) { return n.name === nodeName; }) : null;
            if (!nodeInfo) continue;

            // Minutes Saved[cite: 3, 5]
            totalMinutesSaved += extractMinutesSaved(nodeRuns);

            // Detecção de IA
            const isAiNode = AI_NODE_IDENTIFIERS.some(function(p) { return nodeInfo.type.startsWith(p); }) || 
                             nodeName.includes("TTS") || 
                             nodeName.includes("AI Agent");

            if (isAiNode && !IGNORED_NODE_TYPES.includes(nodeInfo.type)) {
              aiNodeFound = true;
              extractAiDetails(nodeRuns, tokenStats, aiInfo);
            }
          }

          const logData = {
            execution_id: executionId,
            workflow_id: workflowData.id,
            workflow_name: workflowData.name,
            status: fullRunData.status || (fullRunData.finished ? "success" : "error"),
            finished: fullRunData.finished || false,
            started_at: startedAt,
            finished_at: stoppedAt,
            duration_ms: (startedAt && stoppedAt) ? (new Date(stoppedAt).getTime() - new Date(startedAt).getTime()) : null,
            mode: fullRunData.mode,
            node_count: Object.keys(runData).length,
            error_message: (fullRunData.data && fullRunData.data.resultData && fullRunData.data.resultData.error) ? fullRunData.data.resultData.error.message : null,
            has_ai: aiNodeFound,
            ai_model: aiInfo.model,
            total_tokens: tokenStats.totalTokens,
            prompt_tokens: tokenStats.promptTokens,
            completion_tokens: tokenStats.completionTokens,
            minutes_saved: Math.round(totalMinutesSaved)
          };

          console.log("[HOOK] Success: " + executionId + " | Tokens: " + logData.total_tokens);
          await logToSupabase(logData);
        } catch (e) {
          console.error("[HOOK] Critical Failure:", e.message);
        }
      }
    ]
  }
};