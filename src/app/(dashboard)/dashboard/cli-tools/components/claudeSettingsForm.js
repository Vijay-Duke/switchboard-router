// @ts-check
import { buildClaudePassThroughHeaders } from "@/shared/claudeGateway.js";

const CLAUDE_PICKER_LABEL_BATCH_SIZE = 40;

/**
 * @param {{baseUrl?: string|null, models?: string[], pickerLabels?: Record<string, string>}} value
 */
export function buildClaudeCatalogDraftFingerprint({
  baseUrl = "",
  models = [],
  pickerLabels = {},
}) {
  const normalizedModels = models.map((model) => String(model || "").trim()).filter(Boolean);
  return JSON.stringify({
    baseUrl: String(baseUrl || "").trim().replace(/\/+$/, ""),
    models: normalizedModels,
    labels: normalizedModels.map((model) => [model, String(pickerLabels[model] || "").trim()]),
  });
}

/**
 * Generate labels in bounded requests so large saved catalogs do not expose
 * the API's per-request limit to users.
 *
 * @param {{
 *   modelIds: string[],
 *   namingModel?: string,
 *   existingLabels?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export async function requestClaudePickerLabels({
  modelIds,
  namingModel = "",
  existingLabels = {},
  fetchImpl = globalThis.fetch,
}) {
  const labels = {};
  const contextLabels = { ...existingLabels };
  const sources = new Set();

  for (let index = 0; index < modelIds.length; index += CLAUDE_PICKER_LABEL_BATCH_SIZE) {
    const batch = modelIds.slice(index, index + CLAUDE_PICKER_LABEL_BATCH_SIZE);
    const response = await fetchImpl("/api/cli-tools/claude-picker-labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelIds: batch,
        namingModel: namingModel.trim() || undefined,
        existingLabels: contextLabels,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to generate picker labels");
    const batchLabels = data.labels && typeof data.labels === "object" ? data.labels : {};
    Object.assign(labels, batchLabels);
    Object.assign(contextLabels, batchLabels);
    sources.add(data.source === "ai" ? "ai" : "heuristic");
  }

  return {
    labels,
    source: sources.has("ai") ? "ai" : "heuristic",
  };
}

/**
 * Read the Claude model fields exactly as they exist in settings.json.
 * Catalog defaults are suggestions for Apply, not evidence of current config.
 *
 * @param {Array<{ alias: string, envKey?: string }>} models
 * @param {Record<string, any> | null | undefined} settings
 * @returns {Record<string, string>}
 */
export function readClaudeModelMappings(models, settings) {
  const env = settings?.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env
    : {};
  return Object.fromEntries(models.map((model) => [
    model.alias,
    model.envKey && typeof env[model.envKey] === "string" ? env[model.envKey] : "",
  ]));
}

/**
 * Build the Subscription Hybrid settings mutation. Authorization stays with
 * Claude Code's native OAuth while Switchboard uses a separate custom header.
 *
 * @param {{
 *   baseUrl: string,
 *   gatewayKey: string,
 *   models: Array<{ alias: string, envKey?: string, defaultValue?: string }>,
 *   modelMappings: Record<string, string>,
 * }} options
 */
export function buildClaudeSettingsMutation({
  baseUrl,
  gatewayKey,
  models,
  modelMappings,
}) {
  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: buildClaudePassThroughHeaders(gatewayKey),
  };
  const removeEnvKeys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  ];

  for (const model of models) {
    if (!model.envKey) continue;
    const target = String(modelMappings[model.alias] || "").trim();
    const nameKey = `${model.envKey}_NAME`;
    const descriptionKey = `${model.envKey}_DESCRIPTION`;
    if (target) {
      env[model.envKey] = target;
      const slotName = model.alias.charAt(0).toUpperCase() + model.alias.slice(1);
      env[nameKey] = `Switchboard · ${target}`;
      env[descriptionKey] = `${slotName} slot routes through Switchboard to ${target}`;
    } else {
      removeEnvKeys.push(model.envKey, nameKey, descriptionKey);
    }
  }

  return { env, removeEnvKeys };
}

/** @typedef {{kind: "idle"|"apply"|"disconnect", generation: number}} ClaudeToolOperationToken */
/** @typedef {{current: ClaudeToolOperationToken}} ClaudeToolOperationRef */

/**
 * Claim the single Claude settings mutation slot synchronously. React state is
 * deliberately not the lock because two handlers can run before the rerender.
 *
 * @param {ClaudeToolOperationRef} ref
 * @param {"apply"|"disconnect"} kind
 * @returns {ClaudeToolOperationToken|null}
 */
export function beginClaudeToolOperation(ref, kind) {
  if (ref.current.kind !== "idle") return null;
  const token = {
    kind,
    generation: ref.current.generation + 1,
  };
  ref.current = token;
  return token;
}

/**
 * @param {ClaudeToolOperationRef} ref
 * @param {ClaudeToolOperationToken} token
 */
export function isClaudeToolOperationCurrent(ref, token) {
  return ref.current.kind === token.kind
    && ref.current.generation === token.generation;
}

/**
 * Release the mutation slot only when the completing request still owns it.
 *
 * @param {ClaudeToolOperationRef} ref
 * @param {ClaudeToolOperationToken} token
 */
export function finishClaudeToolOperation(ref, token) {
  if (!isClaudeToolOperationCurrent(ref, token)) return false;
  ref.current = { kind: "idle", generation: token.generation };
  return true;
}
