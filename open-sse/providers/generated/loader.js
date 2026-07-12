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

let _warnedNoBuiltins = false;

// Runtime-only builtin lookup — invisible to bundler static analysis.
// process.getBuiltinModule needs Node >= 20.12; on older Node we degrade
// loudly-but-safely: one warning, then fail-open (empty catalog).
function builtinModule(name) {
  if (typeof process === "undefined") return null; // browser: silent fail-open
  if (typeof process.getBuiltinModule !== "function") {
    if (!_warnedNoBuiltins && process.versions?.node) {
      _warnedNoBuiltins = true;
      console.warn(
        `[switchboard] generated model catalog disabled: process.getBuiltinModule requires Node >= 20.12 (running ${process.versions.node}); falling back to hand-maintained data only`
      );
    }
    return null;
  }
  try {
    return process.getBuiltinModule(name);
  } catch {
    return null;
  }
}

// Candidate locations for the default catalog, tried in order (first readable
// wins). cwd-anchored first: in a Next standalone deploy the compiled chunk's
// import.meta.url points inside .next/server/chunks/, while the traced
// catalog.json lands at <standalone root>/open-sse/providers/generated/
// (see outputFileTracingIncludes in next.config.mjs) and the server runs with
// cwd = standalone root. Module-relative second: exact in source runs (dev,
// vitest, scripts) regardless of cwd.
function defaultCatalogPaths() {
  const candidates = [];
  const path = builtinModule("node:path");
  if (path && typeof process.cwd === "function") {
    try {
      candidates.push(path.join(process.cwd(), "open-sse", "providers", "generated", "catalog.json"));
    } catch { /* fall through to module-relative */ }
  }
  const url = builtinModule("node:url");
  if (url) {
    try {
      candidates.push(url.fileURLToPath(new URL("./catalog.json", import.meta.url)));
    } catch { /* no module-relative candidate */ }
  }
  return candidates;
}

function parseCatalog(raw) {
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") return EMPTY;
  return {
    pricing: parsed.pricing && typeof parsed.pricing === "object" ? parsed.pricing : {},
    capabilities:
      parsed.capabilities && typeof parsed.capabilities === "object"
        ? parsed.capabilities
        : {},
  };
}

export function readCatalogFile(path) {
  const fs = builtinModule("node:fs");
  if (!fs) return EMPTY;

  const targets = path === undefined ? defaultCatalogPaths() : [path];
  for (const target of targets) {
    if (typeof target !== "string") continue;
    try {
      return parseCatalog(fs.readFileSync(target, "utf8"));
    } catch {
      // unreadable/corrupt candidate → try the next one, else fail open
    }
  }
  return EMPTY;
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
