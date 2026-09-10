// @ts-check
/**
 * Normalize per-model reasoning support from OpenAI-compatible gateway
 * catalogs (GET /v1/models) into Switchboard's wire-format vocabulary.
 *
 * Known catalog shapes (verified live 2026-09):
 *   - Surplus Intelligence / OpenRouter / Nous Hermes: `supported_parameters`
 *     array listing "reasoning_effort" (flat) and/or "reasoning" (nested) —
 *     the two spellings are NOT interchangeable on SI; the array says which.
 *   - ZENMux: `capabilities: { reasoning: true }` (chat accepts flat+nested).
 *   - CrofAI: per-model `reasoning_effort: true` flag (flat only).
 *
 * Effort axis vocabulary: "flat" (reasoning_effort string) | "nested"
 * (reasoning:{effort} object). The on/off axis ("qwen" enable_thinking,
 * vendor thinking objects) is node-level today — see staticNodeReasoningDefault.
 */

/** @param {unknown} v */
function asBool(v) {
  return v === true || v === "true";
}

/**
 * @param {any} rawModel - raw model object from the gateway's /models listing
 * @returns {{ supported: boolean, effort: "flat"|"nested"|null } | null}
 *   null when the catalog exposes no reasoning signal at all (unknown — the
 *   caller falls back to node defaults / static capability patterns).
 */
export function normalizeReasoningSupport(rawModel) {
  if (!rawModel || typeof rawModel !== "object") return null;
  let sawSignal = false;

  // Surplus Intelligence / OpenRouter / Nous: supported_parameters array.
  if (Array.isArray(rawModel.supported_parameters)) {
    const has = (p) => rawModel.supported_parameters.some(
      (x) => typeof x === "string" && x.toLowerCase() === p,
    );
    if (has("reasoning_effort")) return { supported: true, effort: "flat" };
    if (has("reasoning")) return { supported: true, effort: "nested" };
    sawSignal = true;
  }

  // ZENMux: capabilities.reasoning (chat wire accepts flat; nested also OK).
  if (rawModel.capabilities && typeof rawModel.capabilities === "object"
    && rawModel.capabilities.reasoning !== undefined) {
    if (asBool(rawModel.capabilities.reasoning)) return { supported: true, effort: "flat" };
    sawSignal = true;
  }

  // CrofAI: per-model reasoning_effort flag.
  if (rawModel.reasoning_effort !== undefined) {
    if (asBool(rawModel.reasoning_effort)) return { supported: true, effort: "flat" };
    sawSignal = true;
  }

  // Signal present but every source negative → model cannot reason on this
  // gateway; thinking params must be stripped.
  if (sawSignal) return { supported: false, effort: null };
  return null;
}

/**
 * Defensive shape check for values crossing the /api/models/custom boundary.
 * @param {unknown} value
 * @returns {value is { supported: boolean, effort: "flat"|"nested"|null }}
 */
export function isValidReasoningSupport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.supported !== "boolean") return false;
  return value.effort == null || value.effort === "flat" || value.effort === "nested";
}

// Docs-researched defaults for gateways without runtime introspection.
// Matched against the node's baseUrl host, suffix-anchored.
//   "qwen"  → enable_thinking + thinking_budget (DashScope compatible-mode,
//             incl. the token-plan hosts)
//   "flat"  → reasoning_effort string (opencode Zen/Go rejects thinking
//             objects with HTTP 400; flat is the accepted spelling)
//   "none"  → no request-body control exists (Nous Hermes reasoning is
//             system-prompt-toggled) → strip thinking params
const STATIC_HOST_RULES = [
  { suffix: "aliyuncs.com", format: "qwen" },
  { suffix: "opencode.ai", format: "flat" },
  { suffix: "api.surplusintelligence.ai", format: "flat" },
  { suffix: "inference-api.nousresearch.com", format: "none" },
];

/**
 * @param {unknown} baseUrl - node baseUrl from providerNodes data
 * @returns {"flat"|"nested"|"qwen"|"none"|null} null when host is unknown
 */
export function staticNodeReasoningDefault(baseUrl) {
  let host = "";
  try {
    host = new URL(String(baseUrl || "")).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  for (const rule of STATIC_HOST_RULES) {
    if (host === rule.suffix || host.endsWith(`.${rule.suffix}`)) return rule.format;
  }
  return null;
}
