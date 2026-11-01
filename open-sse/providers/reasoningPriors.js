// Reasoning-level priors from external catalogs (models.dev + OpenRouter),
// synced into generated/catalog.json by scripts/fetch-reasoning-catalog.mjs.
//
// Why: per-family hand-coded level lists go stale the week a vendor ships a
// new tier (GLM-5.3 gained low/high/max while the registry still said ZAI is
// binary, so /v1/models advertised no effort at all). Priors are DATA: a
// catalog refresh updates every model's levels with no code change. They only
// upgrade low-information format defaults (binary/base) in thinkingLevels.js —
// curated rich formats and live upstream claims still win, and the loader
// fails open to today's behavior when the catalog is unavailable (browser).
import { getGeneratedReasoning } from "./generated/loader.js";

// Switchboard provider id -> catalog provider namespaces to try, in order.
// Deliberately tiny: bare-model consensus below covers everything else.
const PROVIDER_ALIASES = {
  glm: ["zai", "zai-coding-plan"],
  zai: ["zai", "zai-coding-plan"],
  "z-ai": ["zai", "zai-coding-plan"],
  opencode: ["opencode", "opencode-go"],
  "opencode-go": ["opencode-go", "opencode"],
};

let testPriors = null;

function bareModelId(model) {
  const id = String(model || "");
  const bare = id.includes("/") ? id.split("/").pop() : id;
  return String(bare || "").split(":")[0].toLowerCase();
}

/**
 * Pure lookup over a reasoning-priors map. Tries provider-qualified keys
 * (exact provider, then aliases) before the bare-model consensus entry.
 * Keys in the map are lowercase; lookups are case-insensitive.
 * @param {Record<string, {levels?: string[], toggle?: boolean, budget?: object, mandatory?: boolean, default?: string}> | null | undefined} map
 * @param {string | null | undefined} provider
 * @param {string | null | undefined} model
 */
export function lookupReasoningPrior(map, provider, model) {
  if (!map || typeof map !== "object" || !model) return null;
  const bare = bareModelId(model);
  if (!bare) return null;
  const full = String(model).toLowerCase();
  const providerKey = String(provider || "").toLowerCase();
  const candidates = [providerKey, ...(PROVIDER_ALIASES[providerKey] || [])].filter(Boolean);
  for (const ns of candidates) {
    if (map[`${ns}/${full}`]) return map[`${ns}/${full}`];
    if (map[`${ns}/${bare}`]) return map[`${ns}/${bare}`];
  }
  return map[bare] || map[full] || null;
}

/** Lookup against the generated catalog (or the test override). Never throws. */
export function lookupCatalogReasoning(provider, model) {
  try {
    return lookupReasoningPrior(testPriors ?? getGeneratedReasoning(), provider, model);
  } catch {
    return null;
  }
}

export function __setReasoningPriorsForTests(map) {
  testPriors = map;
}
