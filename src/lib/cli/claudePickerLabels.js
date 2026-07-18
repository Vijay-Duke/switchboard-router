// @ts-check

import { getApiKeys } from "@/lib/db/index.js";
import { UPDATER_CONFIG } from "@/shared/constants/config.js";
import { CLI_TOKEN_HEADER, getCliToken } from "@/shared/utils/cliToken.js";
import {
  buildClaudeCatalogDisplayNameMap,
  formatClaudeCatalogDisplayLabel,
} from "@/shared/claudeCatalogDisplay.js";

const MAX_LABEL_LENGTH = 48;

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((key) => key.isActive !== false)?.key || null;
  } catch {}

  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  headers[CLI_TOKEN_HEADER] = await getCliToken();
  return headers;
}

/**
 * @param {string} label
 */
function sanitizePickerLabel(label) {
  return String(label || "").trim().replace(/[\r\n]+/g, " ").slice(0, MAX_LABEL_LENGTH);
}

/**
 * @param {unknown} text
 */
function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {string[]} modelIds
 * @param {Record<string, string>} existingLabels
 */
function heuristicPickerLabels(modelIds, existingLabels = {}) {
  const heuristic = buildClaudeCatalogDisplayNameMap(modelIds);
  /** @type {Record<string, string>} */
  const labels = {};
  for (const modelId of modelIds) {
    labels[modelId] = sanitizePickerLabel(
      existingLabels[modelId] || heuristic.get(modelId) || formatClaudeCatalogDisplayLabel(modelId),
    );
  }
  return labels;
}

/**
 * @param {string[]} modelIds
 * @param {Record<string, string>} existingLabels
 */
function buildPickerLabelPrompt(modelIds, existingLabels = {}) {
  const existing = Object.entries(existingLabels)
    .filter(([, label]) => String(label || "").trim())
    .map(([modelId, label]) => `- ${modelId} -> ${label}`)
    .join("\n");

  return [
    "Create short, distinct labels for a terminal model picker.",
    "Rules:",
    "- Return ONLY a JSON object mapping each model ID to its label.",
    "- Max 32 characters per label.",
    "- Keep provider/source distinct (kr vs cr vs llm/lite-llm).",
    "- Include model family and region when useful (opus, sonnet, apac, bedrock).",
    "- Labels must be unique within this batch.",
    "",
    "Models:",
    ...modelIds.map((modelId) => `- ${modelId}`),
    "",
    existing ? `Existing labels in this catalog (stay distinct from these):\n${existing}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * @param {{
 *   modelIds: string[],
 *   namingModel?: string,
 *   existingLabels?: Record<string, string>,
 *   baseUrl?: string,
 * }} options
 */
export async function generateClaudePickerLabels({
  modelIds,
  namingModel,
  existingLabels = {},
  baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`,
}) {
  const models = [...new Set(
    (Array.isArray(modelIds) ? modelIds : [])
      .map((modelId) => String(modelId || "").trim())
      .filter(Boolean),
  )];
  if (models.length === 0) return { labels: {}, source: "heuristic" };

  const fallback = heuristicPickerLabels(models, existingLabels);
  const model = String(namingModel || "").trim();
  if (!model) return { labels: fallback, source: "heuristic" };

  const headers = await getInternalHeaders();
  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content: "You write concise UI labels for AI model pickers. Respond with JSON only.",
        },
        {
          role: "user",
          content: buildPickerLabelPrompt(models, existingLabels),
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Label model returned HTTP ${response.status}`;
    throw new Error(message);
  }

  const content = payload?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { labels: fallback, source: "heuristic" };
  }

  /** @type {Record<string, string>} */
  const labels = { ...fallback };
  let usedAi = false;
  for (const modelId of models) {
    const candidate = sanitizePickerLabel(parsed[modelId]);
    if (candidate) {
      labels[modelId] = candidate;
      usedAi = true;
    }
  }
  return { labels, source: usedAi ? "ai" : "heuristic" };
}
