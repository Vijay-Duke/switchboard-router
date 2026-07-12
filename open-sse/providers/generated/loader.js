// Fail-open contract: unavailable or invalid generated data is treated as empty.
// Generated pricing overrides canonical/pattern values but never explicit PROVIDER_PRICING;
// generated capabilities fill gaps while explicit hand-authored values win.
//
// This module is imported by client-shared code (capabilities.js → useModelCaps),
// so it must NOT statically import node builtins — webpack would fail the client
// bundle. Builtins are resolved lazily via process.getBuiltinModule; in a browser
// that hook is absent and the loader fails open to an empty catalog.

const EMPTY = { pricing: {}, capabilities: {} };

let _cache;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Runtime-only builtin lookup — invisible to bundler static analysis.
function builtinModule(name) {
  if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") return null;
  try {
    return process.getBuiltinModule(name);
  } catch {
    return null;
  }
}

function defaultCatalogPath() {
  const url = builtinModule("node:url");
  if (!url) return null;
  try {
    return url.fileURLToPath(new URL("./catalog.json", import.meta.url));
  } catch {
    return null;
  }
}

export function readCatalogFile(path) {
  const fs = builtinModule("node:fs");
  const target = path === undefined ? defaultCatalogPath() : path;
  if (!fs || typeof target !== "string") return EMPTY;

  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      return EMPTY;
    }

    return {
      pricing: parsed.pricing && typeof parsed.pricing === "object" ? parsed.pricing : {},
      capabilities:
        parsed.capabilities && typeof parsed.capabilities === "object"
          ? parsed.capabilities
          : {},
    };
  } catch {
    return EMPTY;
  }
}

export function getGeneratedCatalog() {
  if (_cache === undefined) {
    _cache = readCatalogFile();
  }

  return _cache;
}

export function __resetCatalogCache() {
  _cache = undefined;
}

function getGeneratedValue(map, model) {
  if (!model) return null;

  assert(typeof model === "string", "model must be a string");
  const base = model.includes("/") ? model.split("/").pop() : model;
  assert(typeof base === "string", "model base must be a string");

  return map[base] || map[model] || null;
}

export function getGeneratedPricing(model) {
  return getGeneratedValue(getGeneratedCatalog().pricing, model);
}

export function getGeneratedCapabilities(model) {
  return getGeneratedValue(getGeneratedCatalog().capabilities, model);
}
