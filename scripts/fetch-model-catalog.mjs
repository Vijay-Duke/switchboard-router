import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MODEL_PRICING,
  PROVIDER_PRICING,
} from "../open-sse/providers/pricing.js";
import {
  MODEL_CAPABILITIES,
  PROVIDER_CAPABILITIES,
} from "../open-sse/providers/capabilities.js";
import { PROVIDER_MODELS } from "../open-sse/providers/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ROOT, "open-sse", "providers", "generated", "catalog.json");
const DEFAULT_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const SOURCE = "litellm:model_prices_and_context_window.json";
const SKIPPED_MODES = new Set([
  "embedding",
  "moderation",
  "audio_transcription",
  "audio_speech",
  "rerank",
]);

export const MODEL_ALIASES = Object.freeze({
  "gpt-4-1106-preview": "gpt-4-turbo",
  "gpt-4-0125-preview": "gpt-4-turbo",
  "gpt-4-turbo-preview": "gpt-4-turbo",
  "gpt-4-turbo-2024-04-09": "gpt-4-turbo",
  "gpt-4o-2024-05-13": "gpt-4o",
  "gpt-4o-2024-08-06": "gpt-4o",
  "gpt-4o-2024-11-20": "gpt-4o",
  "gpt-4.1-2025-04-14": "gpt-4.1",
  "gpt-5-2025-08-07": "gpt-5",
  "gpt-5-mini-2025-08-07": "gpt-5-mini",
  "claude-3-5-sonnet-latest": "claude-3-5-sonnet-20241022",
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "gemini-2.5-pro-preview-06-05": "gemini-2.5-pro",
  "gemini-2.5-flash-preview-05-20": "gemini-2.5-flash",
  "gemini-2.5-flash-lite-preview-06-17": "gemini-2.5-flash-lite",
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? Math.floor(number) : null;
}

function knownIdSet(knownIds) {
  if (knownIds instanceof Set) return knownIds;
  if (Array.isArray(knownIds)) return new Set(knownIds);
  if (knownIds && typeof knownIds === "object") return new Set(Object.keys(knownIds));
  return new Set();
}

function providerSet(providers) {
  const values = providers instanceof Set
    ? [...providers]
    : Array.isArray(providers) ? providers : String(providers || "").split(",");
  return new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean));
}

function supported(entry, source, target) {
  return typeof entry[source] === "boolean" ? { [target]: entry[source] } : {};
}

/** Convert a LiteLLM per-token dollar price to dollars per million tokens. */
export function to1M(value) {
  const price = finiteNumber(value);
  if (price === null || price < 0) return null;
  return Number((price * 1_000_000).toPrecision(15));
}

/** Extract Switchboard pricing fields from one LiteLLM catalog entry. */
export function pricingFromEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const input = to1M(entry.input_cost_per_token);
  const output = to1M(entry.output_cost_per_token);
  if (input === null || output === null) return null;

  const pricing = { input, output };
  const cached = to1M(entry.cache_read_input_token_cost);
  const cacheCreation = to1M(entry.cache_creation_input_token_cost);
  const reasoning = to1M(entry.output_cost_per_reasoning_token);
  if (cached !== null) pricing.cached = cached;
  if (cacheCreation !== null) pricing.cache_creation = cacheCreation;
  if (reasoning !== null) pricing.reasoning = reasoning;
  return pricing;
}

/** Extract explicitly stated capability deltas from one LiteLLM catalog entry. */
export function capabilitiesFromEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const capabilities = {
    ...supported(entry, "supports_vision", "vision"),
    ...supported(entry, "supports_pdf_input", "pdf"),
    ...supported(entry, "supports_audio_input", "audioInput"),
    ...supported(entry, "supports_video_input", "videoInput"),
    ...supported(entry, "supports_image_output", "imageOutput"),
    ...supported(entry, "supports_audio_output", "audioOutput"),
    ...supported(entry, "supports_function_calling", "tools"),
    ...supported(entry, "supports_reasoning", "reasoning"),
    ...supported(entry, "supports_web_search", "search"),
  };
  if (entry.mode === "image_generation" || entry.supports_image_generation === true) {
    capabilities.imageOutput = true;
  }

  const contextWindow = positiveInteger(entry.max_input_tokens ?? entry.max_tokens);
  const maxOutput = positiveInteger(entry.max_output_tokens ?? entry.max_tokens);
  if (contextWindow !== null) capabilities.contextWindow = contextWindow;
  if (maxOutput !== null) capabilities.maxOutput = maxOutput;
  return Object.keys(capabilities).length ? capabilities : null;
}

// Generic ids whose LiteLLM meaning differs from ours — e.g. LiteLLM's "auto"
// is OpenRouter's router pseudo-model ($0, 2M ctx) while ours is a generic
// fallback rate. Mapping them would corrupt local data; always skip.
const EXCLUDED_IDS = new Set(["auto"]);

/** Resolve a LiteLLM model key to a known Switchboard model ID. */
export function resolveOurId(modelId, knownIds) {
  if (typeof modelId !== "string" || !modelId.trim()) return null;

  const known = knownIdSet(knownIds);
  const candidates = [modelId.trim()];
  const slash = modelId.lastIndexOf("/");
  if (slash >= 0) candidates.push(modelId.slice(slash + 1));
  for (const candidate of [...candidates]) {
    if (MODEL_ALIASES[candidate]) candidates.push(MODEL_ALIASES[candidate]);
  }

  for (const candidate of candidates) {
    if (EXCLUDED_IDS.has(candidate.toLowerCase())) continue;
    if (known.has(candidate)) return candidate;
    const lower = candidate.toLowerCase();
    for (const knownId of known) {
      if (knownId.toLowerCase() === lower) return knownId;
    }
  }
  return null;
}

/** Map one LiteLLM catalog record to a known Switchboard model record. */
export function mapCatalogEntry(modelId, entry, knownIds) {
  const id = resolveOurId(modelId, knownIds);
  if (!id) return null;

  const pricing = pricingFromEntry(entry);
  const capabilities = capabilitiesFromEntry(entry);
  if (!pricing && !capabilities) return null;
  return { id, pricing, capabilities };
}

/** Build the deterministic generated catalog from LiteLLM's model map. */
export function buildCatalog(entries, knownIds, providers, fetchedAt = null) {
  assert(entries && typeof entries === "object" && !Array.isArray(entries), "entries must be an object");
  const selectedProviders = providerSet(providers);
  const pricing = {};
  const capabilities = {};

  // Two passes: exact canonical keys (litellm key === our id) beat
  // provider-prefixed variants (e.g. "azure/gpt-5") regardless of sort order;
  // within each pass, the first sorted key wins for determinism.
  const sortedKeys = Object.keys(entries).sort();
  for (const exactPass of [true, false]) {
    for (const modelId of sortedKeys) {
      const entry = entries[modelId];
      if (!entry || typeof entry !== "object") continue;
      if (SKIPPED_MODES.has(entry.mode)) continue;
      const provider = String(entry.litellm_provider || "").toLowerCase();
      if (selectedProviders.size && !selectedProviders.has(provider)) continue;

      const mapped = mapCatalogEntry(modelId, entry, knownIds);
      if (!mapped) continue;
      if (exactPass !== (mapped.id === modelId)) continue;
      if (mapped.pricing && !pricing[mapped.id]) pricing[mapped.id] = mapped.pricing;
      if (mapped.capabilities && !capabilities[mapped.id]) capabilities[mapped.id] = mapped.capabilities;
    }
  }

  return {
    fetchedAt,
    source: SOURCE,
    note: "GENERATED FILE — regenerate with `npm run catalog:refresh`. Do not hand-edit.",
    pricing,
    capabilities,
  };
}

/** JSON.stringify with recursively sorted object keys and preserved array order. */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value), null, 2);
}

function getKnownIds() {
  const ids = new Set([
    ...Object.keys(MODEL_PRICING),
    ...Object.keys(MODEL_CAPABILITIES),
  ]);
  for (const models of Object.values(PROVIDER_PRICING)) idsForObject(ids, models);
  for (const models of Object.values(PROVIDER_CAPABILITIES)) idsForObject(ids, models);
  for (const models of Object.values(PROVIDER_MODELS)) {
    for (const model of models) ids.add(typeof model === "string" ? model : model.id);
  }
  ids.delete(undefined);
  return ids;
}

function idsForObject(ids, models) {
  for (const id of Object.keys(models || {})) ids.add(id);
}

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    url: DEFAULT_URL,
    providers: [],
    dryRun: false,
    live: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--live") options.live = true;
    else if (argument === "--out" || argument === "--url" || argument === "--providers") {
      const value = argv[index + 1];
      assert(value && !value.startsWith("--"), `${argument} requires a value`);
      if (argument === "--out") options.out = path.resolve(value);
      if (argument === "--url") options.url = value;
      if (argument === "--providers") options.providers = providerSet(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const response = await fetch(options.url);
  if (!response.ok) throw new Error(`LiteLLM fetch failed: ${response.status} ${response.statusText}`);
  const entries = await response.json();
  const knownIds = getKnownIds();
  if (options.live) {
    try {
      const port = process.env.PORT || 20128;
      const apiKey = process.env.SWITCHBOARD_API_KEY || "sk_switchboard";
      const liveResponse = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!liveResponse.ok) throw new Error(`HTTP ${liveResponse.status}`);
      const liveCatalog = await liveResponse.json();
      if (!Array.isArray(liveCatalog.data)) throw new Error("response missing data array");
      for (const model of liveCatalog.data) {
        if (model && typeof model.id === "string" && model.id) knownIds.add(model.id);
      }
    } catch (error) {
      console.error(`catalog: live model lookup failed: ${error.message}`);
    }
  }
  const catalog = buildCatalog(entries, knownIds, options.providers, new Date().toISOString());
  const output = `${stableStringify(catalog)}\n`;
  if (options.dryRun) process.stdout.write(output);
  else await fs.writeFile(options.out, output, "utf8");

  const filters = options.providers.size ? [...options.providers].sort().join(",") : "all";
  console.error(`catalog: ${Object.keys(catalog.pricing).length} pricing, ${Object.keys(catalog.capabilities).length} capabilities; providers=${filters}; ${options.dryRun ? "dry-run" : options.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`catalog: ${error.message}`);
    process.exitCode = 1;
  });
}
