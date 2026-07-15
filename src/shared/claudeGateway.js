// @ts-check

export const CLAUDE_ROUTING_MODES = Object.freeze({
  PASS_THROUGH: "pass-through",
  PROXY: "proxy",
  FULL_CATALOG: "full-catalog",
});
export const CLAUDE_ROUTING_MODE_HEADER = "x-switchboard-claude-mode";
export const CLAUDE_CATALOG_SELECTION_HEADER = "x-switchboard-claude-models";
export const SWITCHBOARD_KEY_HEADER = "x-switchboard-key";
export const CLAUDE_CATALOG_MODEL_PREFIX = "claude-switchboard-v1/";
const CLAUDE_GATEWAY_ALIAS_PATTERN = /^(?:claude|anthropic)-[a-z0-9][a-z0-9._-]*$/i;

/** @param {string} name */
const formatHeaderName = (name) => name.replace(
  /(^|-)([a-z])/g,
  (_, separator, character) => `${separator}${character.toUpperCase()}`,
);

/**
 * @param {unknown} value
 * @param {string} headerName
 */
function readCustomHeaderValue(value, headerName) {
  if (typeof value !== "string") return "";
  for (const line of value.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (name === headerName) return line.slice(separatorIndex + 1).trim();
  }
  return "";
}

/** @param {unknown} alias */
export function isClaudeGatewayAlias(alias) {
  return typeof alias === "string" && CLAUDE_GATEWAY_ALIAS_PATTERN.test(alias);
}

/** @param {string} gatewayKey */
export function buildClaudePassThroughHeaders(gatewayKey) {
  return [
    `${formatHeaderName(SWITCHBOARD_KEY_HEADER)}: ${gatewayKey}`,
    `${formatHeaderName(CLAUDE_ROUTING_MODE_HEADER)}: ${CLAUDE_ROUTING_MODES.PASS_THROUGH}`,
  ].join("\n");
}

/** @param {unknown} values */
export function normalizeClaudeCatalogSelection(values) {
  if (!Array.isArray(values)) throw new TypeError("Claude catalog models must be an array.");
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") throw new TypeError("Each Claude catalog model must be a string.");
    const model = value.trim();
    if (!model) continue;
    if (/\r|\n/.test(model)) throw new TypeError("Claude catalog model IDs cannot contain newlines.");
    if (seen.has(model)) continue;
    seen.add(model);
    normalized.push(model);
  }
  return normalized;
}

/** @param {unknown} models */
export function buildClaudeCatalogSelectionHeader(models) {
  return encodeURIComponent(JSON.stringify(normalizeClaudeCatalogSelection(models)));
}

/** @param {unknown} value */
function decodeClaudeCatalogSelectionHeader(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return normalizeClaudeCatalogSelection(JSON.parse(decodeURIComponent(value)));
  } catch {
    return [];
  }
}

/** @param {unknown} value */
export function readClaudeCatalogSelectionFromCustomHeaders(value) {
  return decodeClaudeCatalogSelectionHeader(
    readCustomHeaderValue(value, CLAUDE_CATALOG_SELECTION_HEADER),
  );
}

/** @param {{ get: (name: string) => string|null } | null | undefined} headers */
export function readClaudeCatalogSelectionFromHeaders(headers) {
  return decodeClaudeCatalogSelectionHeader(headers?.get(CLAUDE_CATALOG_SELECTION_HEADER));
}

/** @param {unknown} models */
export function buildClaudeFullCatalogHeaders(models = []) {
  return [
    `${formatHeaderName(CLAUDE_ROUTING_MODE_HEADER)}: ${CLAUDE_ROUTING_MODES.FULL_CATALOG}`,
    `${formatHeaderName(CLAUDE_CATALOG_SELECTION_HEADER)}: ${buildClaudeCatalogSelectionHeader(models)}`,
  ].join("\n");
}

/** @param {string} modelId */
export function encodeClaudeCatalogModelId(modelId) {
  const canonical = String(modelId || "").trim();
  if (!canonical) throw new TypeError("A Switchboard model ID is required.");
  const encoded = canonical.split("/").map(encodeURIComponent).join("/");
  return `${CLAUDE_CATALOG_MODEL_PREFIX}${encoded}`;
}

/** @param {unknown} value */
export function decodeClaudeCatalogModelId(value) {
  if (typeof value !== "string" || !value.startsWith(CLAUDE_CATALOG_MODEL_PREFIX)) return null;
  const encoded = value.slice(CLAUDE_CATALOG_MODEL_PREFIX.length);
  if (!encoded) return null;
  try {
    const decoded = encoded.split("/").map(decodeURIComponent).join("/");
    return encodeClaudeCatalogModelId(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Build command-line-precedence settings for the separate
 * `claude-switchboard` launcher. This profile intentionally does not contain
 * or reuse Claude subscription OAuth credentials.
 *
 * @param {{baseUrl: string, gatewayKey: string, models?: string[]}} options
 */
export function buildClaudeFullCatalogProfile({ baseUrl, gatewayKey, models = [] }) {
  const normalizedUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const normalizedKey = String(gatewayKey || "").trim();
  if (!normalizedUrl) throw new TypeError("A Switchboard endpoint is required.");
  if (!normalizedKey) throw new TypeError("A Switchboard API key is required.");
  return {
    env: {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: normalizedKey,
      ANTHROPIC_BASE_URL: normalizedUrl.endsWith("/v1") ? normalizedUrl : `${normalizedUrl}/v1`,
      ANTHROPIC_CUSTOM_HEADERS: buildClaudeFullCatalogHeaders(models),
      ANTHROPIC_CUSTOM_MODEL_OPTION: "",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    },
  };
}

/** @param {unknown} value */
export function hasClaudePassThroughHeader(value) {
  return readCustomHeaderValue(value, CLAUDE_ROUTING_MODE_HEADER).toLowerCase()
    === CLAUDE_ROUTING_MODES.PASS_THROUGH;
}

/** @param {unknown} value */
export function hasClaudeFullCatalogHeader(value) {
  const mode = readCustomHeaderValue(value, CLAUDE_ROUTING_MODE_HEADER).toLowerCase();
  return mode === CLAUDE_ROUTING_MODES.FULL_CATALOG || mode === CLAUDE_ROUTING_MODES.PROXY;
}

/** @param {unknown} value */
export function readSwitchboardKeyFromCustomHeaders(value) {
  return readCustomHeaderValue(value, SWITCHBOARD_KEY_HEADER);
}

/**
 * Classify a live gateway request without duplicating protocol literals in
 * authentication or routing layers.
 *
 * @param {{ get: (name: string) => string|null } | null | undefined} headers
 */
export function isClaudePassThroughRequest(headers) {
  return headers?.get(CLAUDE_ROUTING_MODE_HEADER)?.trim().toLowerCase()
    === CLAUDE_ROUTING_MODES.PASS_THROUGH;
}

/**
 * @param {{ get: (name: string) => string|null } | null | undefined} headers
 */
export function isClaudeFullCatalogRequest(headers) {
  const mode = headers?.get(CLAUDE_ROUTING_MODE_HEADER)?.trim().toLowerCase();
  return mode === CLAUDE_ROUTING_MODES.FULL_CATALOG || mode === CLAUDE_ROUTING_MODES.PROXY;
}
