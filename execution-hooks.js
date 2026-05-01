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

// 🔥 FUNÇÃO RECURSIVA PARA ENCONTRAR TOKEN USAGE EM QUALQUER NÍVEL DO JSON
function findTokenUsage(obj) {
  if (!obj || typeof obj !== "object") return null;

  // caso direto
  if (obj.tokenUsage || obj.usage) {
    return obj.tokenUsage || obj.usage;
  }

  // formato comum OpenAI / LangChain
  if (obj.totalTokens || obj.promptTokens || obj.completionTokens) {
    return obj;
  }

  // busca profunda
  for (const key in obj) {
    const result = findTokenUsage(obj[key]);
    if (result) return result;
  }

  return null;
}

module.exports = {
  n8n: {
    ready: [
      async function () {
        console.log("[HOOK] n8n.ready - Server is ready!");
        if (SUPABASE_URL) {
          console.log("[HOOK] Supabase integration enabled");
        } else {
          console.log("[HOOK] Supabase not configured (set SUPABASE_URL and SUPABASE_SERVICE_KEY)");
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

        // duração
        const startedAt = fullRunData?.startedAt;
        const stoppedAt = fullRunData?.stoppedAt;
        const durationMs =
          startedAt && stoppedAt
            ? new Date(stoppedAt).getTime() - new Date(startedAt).getTime()
            : null;

        let hasAI = false;
        let totalTokens = 0;
        let promptTokens = 0;
        let completionTokens = 0;

        for (const [nodeName, nodeRuns] of Object.entries(resultData)) {
          const nodeInfo = workflowData.nodes?.find(n => n.name === nodeName);

          // detecta nós de IA de forma mais ampla
          if (
            nodeInfo?.type?.toLowerCase().includes("openai") ||
            nodeInfo?.type?.toLowerCase().includes("langchain") ||
            nodeInfo?.type?.toLowerCase().includes("ai") ||
            nodeName.toLowerCase().includes("ai")
          ) {
            hasAI = true;

            for (const run of nodeRuns) {
              const usage = findTokenUsage(run);

              if (usage) {
                totalTokens += usage.totalTokens || usage.total_tokens || 0;
                promptTokens += usage.promptTokens || usage.prompt_tokens || 0;
                completionTokens += usage.completionTokens || usage.completion_tokens || 0;

                console.log("[HOOK] USAGE FOUND:", usage);
              }
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
          duration_ms: durationMs,

          mode: fullRunData?.mode,
          node_count: Object.keys(resultData).length,

          error_message: fullRunData?.data?.resultData?.error?.message || null,

          // métricas IA
          has_ai: hasAI,
          total_tokens: totalTokens,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        };

        console.log(
          "[HOOK] workflow.postExecute:",
          JSON.stringify(
            {
              executionId,
              workflowName: workflowData?.name,
              status: logData.status,
              durationMs,
              nodeCount: logData.node_count,
              hasAI,
              totalTokens,
              promptTokens,
              completionTokens,
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