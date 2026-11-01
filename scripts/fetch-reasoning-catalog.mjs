// Sync reasoning-level priors from models.dev + OpenRouter into the
// generated catalog (open-sse/providers/generated/catalog.json, `reasoning`
// section). Run via `npm run reasoning:refresh` (also chained from
// catalog:refresh). The LiteLLM sync (fetch-model-catalog.mjs) preserves this
// section when it rewrites pricing/capabilities.
//
// Why: thinking levels used to be hand-coded per format/family and went stale
// whenever a vendor shipped new tiers (GLM-5.3 gained low/high/max while the
// registry still called ZAI binary, so /v1/models advertised no effort at
// all). Priors are data — refreshing this file updates every model at once.
// Runtime resolution lives in open-sse/providers/reasoningPriors.js; priors
// only upgrade low-information format defaults, never curated rich formats.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stableStringify, writeFileAtomic } from "./fetch-model-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ROOT, "open-sse", "providers", "generated", "catalog.json");
const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

// Canonical advertised levels, weakest first. "none" is a disable claim, not
// a level; disable-ability is tracked separately during the build.
const CANONICAL_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

function normalizeLevels(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set(values.map((v) => String(v || "").toLowerCase()));
  return CANONICAL_LEVELS.filter((level) => seen.has(level));
}

function bareId(modelId) {
  const id = String(modelId || "");
  const bare = id.includes("/") ? id.split("/").pop() : id;
  return String(bare || "").split(":")[0].toLowerCase();
}

function finiteInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function budgetOf(option) {
  const min = finiteInt(option?.min);
  const max = finiteInt(option?.max);
  if (min === null && max === null) return null;
  return { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
}

// One source record: { key, bare, body, canDisable, mandatory, def }
// body is the emitted shape ({levels}|{toggle}|{budget}); canDisable /
// mandatory / def are build-time meta folded into bare entries at emit time.
function fromModelsDev(modelsDev) {
  const records = [];
  if (!modelsDev || typeof modelsDev !== "object") return records;
  for (const provider of Object.keys(modelsDev).sort()) {
    const models = modelsDev[provider]?.models;
    if (!models || typeof models !== "object") continue;
    for (const modelId of Object.keys(models).sort()) {
      const model = models[modelId];
      if (!model || model.reasoning !== true) continue;
      const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
      const effort = options.find((o) => o?.type === "effort");
      const toggle = options.some((o) => o?.type === "toggle");
      const budgetOpt = options.find((o) => o?.type === "budget_tokens");
      const budget = budgetOpt ? budgetOf(budgetOpt) : null;
      const levels = normalizeLevels(effort?.values);
      const canDisable = toggle
        || (Array.isArray(effort?.values) && effort.values.map(String).includes("none"));
      let body = null;
      if (levels.length) body = { levels, ...(budget ? { budget } : {}) };
      else if (toggle) body = { toggle: true, ...(budget ? { budget } : {}) };
      else if (budget) body = { budget };
      else body = { toggle: true };
      records.push({
        key: `${provider}/${modelId}`.toLowerCase(),
        bare: bareId(modelId),
        body,
        canDisable,
        mandatory: false,
        def: null,
      });
    }
  }
  return records;
}

function fromOpenRouter(openRouter) {
  const records = [];
  const data = Array.isArray(openRouter?.data) ? openRouter.data : [];
  for (const model of data) {
    const id = String(model?.id || "");
    if (!id || id.startsWith("~")) continue; // ~latest aliases duplicate real ids
    const r = model?.reasoning && typeof model.reasoning === "object" ? model.reasoning : null;
    const params = Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
    if (!r && !params.includes("reasoning")) continue;
    const levels = normalizeLevels(r?.supported_efforts);
    const canDisable = r?.mandatory === false
      || (Array.isArray(r?.supported_efforts) && r.supported_efforts.map(String).includes("none"));
    const defRaw = String(r?.default_effort || "").toLowerCase();
    records.push({
      key: id.toLowerCase(),
      bare: bareId(id),
      body: levels.length ? { levels } : { toggle: true },
      canDisable,
      mandatory: r?.mandatory === true,
      def: levels.includes(defRaw) ? defRaw : null,
    });
  }
  return records;
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

function composeEntry(record) {
  return {
    ...record.body,
    ...(record.mandatory ? { mandatory: true } : {}),
    ...(record.def ? { default: record.def } : {}),
  };
}

/**
 * Build the `reasoning` catalog section from models.dev (primary levels) and
 * OpenRouter (fills missing models + mandatory/default). Emits a bare-model
 * consensus entry per model plus provider-qualified entries only where they
 * differ from consensus, so route-specific catalogs keep their exact sets.
 */
export function buildReasoningCatalog({ modelsDev = null, openRouter = null } = {}) {
  const records = [...fromModelsDev(modelsDev), ...fromOpenRouter(openRouter)];
  const byKey = new Map();
  for (const record of records) {
    const prev = byKey.get(record.key);
    if (!prev) {
      byKey.set(record.key, record);
      continue;
    }
    // Same qualified key from both sources: keep the first body (models.dev
    // was collected first), fold in mandatory/default/canDisable meta.
    prev.mandatory = prev.mandatory || record.mandatory;
    prev.canDisable = prev.canDisable || record.canDisable;
    if (!prev.def && record.def) prev.def = record.def;
  }

  const byBare = new Map();
  for (const record of byKey.values()) {
    const group = byBare.get(record.bare) || [];
    group.push(record);
    byBare.set(record.bare, group);
  }

  const reasoning = {};
  const bareEntries = new Map();
  for (const bare of [...byBare.keys()].sort()) {
    const group = byBare.get(bare);
    const bodyJson = mostCommon(group.map((r) => JSON.stringify(r.body)));
    const mandatory = group.some((r) => r.mandatory) && !group.some((r) => r.canDisable);
    const def = mostCommon(group.map((r) => r.def).filter(Boolean));
    const entry = {
      ...JSON.parse(bodyJson),
      ...(mandatory ? { mandatory: true } : {}),
      ...(def ? { default: def } : {}),
    };
    reasoning[bare] = entry;
    bareEntries.set(bare, entry);
  }
  for (const key of [...byKey.keys()].sort()) {
    const record = byKey.get(key);
    const entry = composeEntry(record);
    if (JSON.stringify(entry) !== JSON.stringify(bareEntries.get(record.bare))) {
      reasoning[key] = entry;
    }
  }
  return { reasoning };
}

export function mergeReasoningIntoCatalog(existing, reasoning) {
  return { ...(existing && typeof existing === "object" ? existing : {}), reasoning };
}

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT, dryRun: false, modelsDevUrl: MODELS_DEV_URL, openRouterUrl: OPENROUTER_URL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--out") options.out = path.resolve(argv[++i] || "");
    else if (arg === "--models-dev-url") options.modelsDevUrl = argv[++i];
    else if (arg === "--openrouter-url") options.openRouterUrl = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function fetchJson(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${label} fetch failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const modelsDev = await fetchJson(options.modelsDevUrl, "models.dev");
  let openRouter = null;
  try {
    openRouter = await fetchJson(options.openRouterUrl, "OpenRouter");
  } catch (error) {
    console.error(`reasoning: OpenRouter unavailable (${error.message}); building from models.dev only`);
  }
  const { reasoning } = buildReasoningCatalog({ modelsDev, openRouter });

  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(options.out, "utf8"));
  } catch { /* first generation */ }
  const catalog = mergeReasoningIntoCatalog(existing, reasoning);
  const output = `${stableStringify(catalog)}\n`;
  if (options.dryRun) process.stdout.write(output);
  else await writeFileAtomic(options.out, output);
  console.error(
    `reasoning: ${Object.keys(reasoning).length} entries; ${options.dryRun ? "dry-run" : options.out}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`reasoning: ${error.message}`);
    process.exitCode = 1;
  });
}
