console.log("[HOOK FILE] execution-hooks.js loaded at:", new Date().toISOString());

// Supabase configuration from environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Helper function to insert execution log into Supabase
async function logToSupabase(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.log("[HOOK] Supabase not configured, skipping database insert");
    return;
  }

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
      console.error("[HOOK] Supabase insert failed:", response.status, errorText);
    } else {
      console.log("[HOOK] Execution logged to Supabase:", data.execution_id);
    }
  } catch (error) {
    console.error("[HOOK] Supabase error:", error.message);
  }
}

// Busca e soma TODOS os tokens em qualquer nível
function extractTokenUsage(obj, totals = {
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0
}) {
  if (!obj || typeof obj !== "object") return totals;

  if (obj.tokenUsage && typeof obj.tokenUsage === "object") {
    totals.totalTokens += Number(obj.tokenUsage.totalTokens || obj.tokenUsage.total_tokens || 0);
    totals.promptTokens += Number(obj.tokenUsage.promptTokens || obj.tokenUsage.prompt_tokens || 0);
    totals.completionTokens += Number(obj.tokenUsage.completionTokens || obj.tokenUsage.completion_tokens || 0);
  }

  if (
    obj.totalTokens !== undefined ||
    obj.promptTokens !== undefined ||
    obj.completionTokens !== undefined ||
    obj.total_tokens !== undefined ||
    obj.prompt_tokens !== undefined ||
    obj.completion_tokens !== undefined
  ) {
    totals.totalTokens += Number(obj.totalTokens || obj.total_tokens || 0);
    totals.promptTokens += Number(obj.promptTokens || obj.prompt_tokens || 0);
    totals.completionTokens += Number(obj.completionTokens || obj.completion_tokens || 0);
  }

  for (const value of Object.values(obj)) {
    extractTokenUsage(value, totals);
  }

  return totals;
}

module.exports = {
  n8n: {
    ready: [
      async function () {
        console.log("[HOOK] n8n.ready - Server is ready!");
        if (SUPABASE_URL) {
          console.log("[HOOK] Supabase integration enabled");
        } else {
          console.log("[HOOK] Supabase not configured");
        }
      },
    ],
  },

  workflow: {
    activate: [
      async function (updatedWorkflow) {
        console.log("[HOOK] workflow.activate:", updatedWorkflow?.id || updatedWorkflow?.name);
      },
    ],

    create: [
      async function (createdWorkflow) {
        console.log("[HOOK] workflow.create:", createdWorkflow?.id || createdWorkflow?.name);
      },
    ],

    update: [
      async function (updatedWorkflow) {
        console.log("[HOOK] workflow.update:", updatedWorkflow?.id || updatedWorkflow?.name);
      },
    ],

    preExecute: [
      async function (workflow, mode) {
        console.log("[HOOK] workflow.preExecute:", workflow?.name, "mode:", mode);
      },
    ],

    postExecute: [
      async function (fullRunData, workflowData, executionId) {
        const resultData = fullRunData?.data?.resultData?.runData || {};

        const startedAt = fullRunData?.startedAt;
        const stoppedAt = fullRunData?.stoppedAt;

        const durationMs =
          startedAt && stoppedAt
            ? new Date(stoppedAt).getTime() - new Date(startedAt).getTime()
            : null;

        // varre a execução inteira
        const tokenStats = extractTokenUsage(fullRunData);

        const hasAI =
          tokenStats.totalTokens > 0 ||
          tokenStats.promptTokens > 0 ||
          tokenStats.completionTokens > 0;

        const logData = {
          execution_id: executionId,
          workflow_id: workflowData?.id,
          workflow_name: workflowData?.name,

          status: fullRunData?.status || (fullRunData?.finished ? "success" : "error"),
          finished: fullRunData?.finished || false,

          started_at: startedAt,
          finished_at: stoppedAt,
          duration_ms: durationMs,

          mode: fullRunData?.mode,
          node_count: Object.keys(resultData).length,

          error_message: fullRunData?.data?.resultData?.error?.message || null,

          has_ai: hasAI,
          total_tokens: tokenStats.totalTokens,
          prompt_tokens: tokenStats.promptTokens,
          completion_tokens: tokenStats.completionTokens,
        };

        console.log(
          "[HOOK] workflow.postExecute:",
          JSON.stringify(
            {
              executionId,
              workflowName: workflowData?.name,
              status: logData.status,
              durationMs,
              hasAI,
              totalTokens: tokenStats.totalTokens,
              promptTokens: tokenStats.promptTokens,
              completionTokens: tokenStats.completionTokens,
            },
            null,
            2
          )
        );

        await logToSupabase(logData);
      },
    ],
  },
};