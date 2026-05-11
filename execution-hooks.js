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

// Coleta os blocos de token de UMA iteracao (task run). Dedup somente
// dentro desta iteracao, para evitar contar o mesmo bloco que aparece
// duplicado em `data` e `metadata` do n8n. Nao dedupa entre iteracoes.
function collectTokenBlocksInRun(root) {
    const blocks = [];
    const seenFingerprints = new Set();

    function walk(obj) {
        if (!obj || typeof obj !== "object") return;

        const candidates = [
            obj.tokenUsage,
            obj.token_usage,
            obj.tokenUsageEstimate,
            obj.token_usage_estimate,
            obj.usage,
            obj.usage_metadata
        ];

        let found = null;
        for (const candidate of candidates) {
            const normalized = normalizeTokenBlock(candidate);
            if (normalized) {
                found = normalized;
                break;
            }
        }

        if (!found && looksLikeTokenUsage(obj)) {
            found = normalizeTokenBlock(obj);
        }

        if (found) {
            const fingerprint =
                `${found.totalTokens}-${found.promptTokens}-${found.completionTokens}`;
            if (!seenFingerprints.has(fingerprint)) {
                seenFingerprints.add(fingerprint);
                blocks.push(found);
            }
        }

        for (const value of Object.values(obj)) {
            if (typeof value === "object") {
                walk(value);
            }
        }
    }

    walk(root);
    return blocks;
}

/* ================================
   MODEL / PROVIDER DETECTION
================================ */

function extractAiModel(obj) {
    if (!obj || typeof obj !== "object") return null;

    // n8n Resource Locator
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

function extractProvider(nodeType) {
    if (!nodeType || typeof nodeType !== "string") return null;

    // LangChain (especificos antes do generico)
    if (nodeType.startsWith("@n8n/n8n-nodes-langchain.lmChatOpenAi"))      return "openai";
    if (nodeType.startsWith("@n8n/n8n-nodes-langchain.lmChatAnthropic"))   return "anthropic";
    if (nodeType.startsWith("@n8n/n8n-nodes-langchain.lmChatGoogle"))      return "google";
    if (nodeType.startsWith("@n8n/n8n-nodes-langchain.lmChatAwsBedrock"))  return "aws-bedrock";
    if (nodeType.startsWith("@n8n/n8n-nodes-langchain.lmChatOllama"))      return "ollama";
    if (nodeType.startsWith("@n8n/n8n-nodes-langchain.lmChatGroq"))        return "groq";
    if (nodeType.startsWith("@n8n/n8n-nodes-langchain.lmChatMistralCloud"))return "mistral";
    if (nodeType.startsWith("@n8n/n8n-nodes-langchain"))                   return "langchain";

    // Nodes nativos
    if (nodeType.startsWith("n8n-nodes-base.openAi"))     return "openai";
    if (nodeType.startsWith("n8n-nodes-base.anthropic"))  return "anthropic";
    if (nodeType.startsWith("n8n-nodes-base.googlePalm")) return "google";
    if (nodeType.startsWith("n8n-nodes-base.awsBedrock")) return "aws-bedrock";

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
   BUILD TOKEN USAGE ROWS (1 por iteracao de token)
================================ */

function buildTokenUsageRows(executionId, workflowId, resultData, workflowData, createdAt) {
    const rows = [];

    for (const [nodeName, nodeRuns] of Object.entries(resultData)) {
        const nodeInfo = workflowData?.nodes?.find(n => n.name === nodeName);
        if (!nodeInfo) continue;

        const matchesKnownAiNode = AI_NODE_IDENTIFIERS.some(prefix =>
            nodeInfo.type.startsWith(prefix)
        );
        if (!matchesKnownAiNode) continue;
        if (IGNORED_NODE_TYPES.includes(nodeInfo.type)) continue;
        if (!Array.isArray(nodeRuns)) continue;

        const provider = extractProvider(nodeInfo.type);

        for (const run of nodeRuns) {
            const blocks = collectTokenBlocksInRun(run);
            if (blocks.length === 0) continue;

            for (const block of blocks) {
                if (
                    block.totalTokens <= 0 &&
                    block.promptTokens <= 0 &&
                    block.completionTokens <= 0
                ) continue;

                const model = extractAiModel(run) || "unknown";

                rows.push({
                    execution_id: executionId,
                    workflow_id: workflowId,
                    node_name: nodeName,
                    model,
                    provider,
                    prompt_tokens: block.promptTokens,
                    completion_tokens: block.completionTokens,
                    input_cost_usd: 0,
                    output_cost_usd: 0,
                    total_cost_usd: 0,
                    created_at: createdAt
                });
            }
        }
    }

    return rows;
}

/* ================================
   SUPABASE
================================ */

async function postToSupabase(table, payload) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
                "Prefer": "return=minimal"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error(`[HOOK] Supabase ${table} insert failed:`, await response.text());
        }
    } catch (error) {
        console.error(`[HOOK] Supabase ${table} error:`, error.message);
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

                // Timestamp unico: pai (execution_logs) e filhos (token_usage)
                // compartilham o mesmo created_at para garantir alinhamento temporal.
                const createdAt = new Date().toISOString();

                let totalMinutesSaved = 0;
                for (const nodeRuns of Object.values(resultData)) {
                    totalMinutesSaved += extractTimeSaved(nodeRuns);
                }

                const triggerType = extractTriggerType(fullRunData);
                const workflowId = workflowData?.id;

                const tokenUsageRows = buildTokenUsageRows(
                    executionId,
                    workflowId,
                    resultData,
                    workflowData,
                    createdAt
                );

                const logData = {
                    execution_id: executionId,
                    workflow_id: workflowId,
                    workflow_name: workflowData?.name,

                    status:
                        fullRunData?.status ||
                        (fullRunData?.finished ? "success" : "error"),

                    finished: fullRunData?.finished || false,

                    started_at: startedAt,
                    finished_at: stoppedAt,
                    created_at: createdAt,

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

                    minutes_saved: Math.round(totalMinutesSaved)
                };

                console.log(
                    `[HOOK] ID ${executionId} | Trigger: ${triggerType} | token rows: ${tokenUsageRows.length} | minutesSaved: ${logData.minutes_saved}`
                );

                // Ordem critica: fact precisa existir antes do FK do token_usage
                await postToSupabase("n8n_execution_logs", logData);

                if (tokenUsageRows.length > 0) {
                    await postToSupabase("n8n_token_usage", tokenUsageRows);
                }
            }
        ]
    }
};
