// @ts-check

/**
 * Build a stable key for dedupe and probe-cache lookups. The stored key is
 * deliberately stricter than display text: casing, provider prefixes, and
 * Gemini-style "models/" prefixes should not create duplicate probe rows.
 *
 * @param {string} modelId
 * @param {string} [providerAlias]
 * @returns {string}
 */
export function canonicalModelId(modelId, providerAlias = "") {
  let id = String(modelId || "").trim();
  if (!id) return "";
  id = id.replace(/\s+/g, "");
  id = id.replace(/^models\//i, "");
  const alias = String(providerAlias || "").trim();
  if (alias && id.toLowerCase().startsWith(`${alias.toLowerCase()}/`)) {
    id = id.slice(alias.length + 1);
  }
  id = id.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  return id.toLowerCase();
}
