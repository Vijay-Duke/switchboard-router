/**
 * Parse router model JSON: { model, cluster, confidence, reason, alternates? }
 * Fail-open helpers for markdown fences and trailing junk.
 * @param {string} text
 * @param {string[]} pool
 * @returns {{ model: string, cluster: string, confidence: string, reason: string, alternates: string[], parseError?: string }}
 */
export function parseRouterPick(text, pool) {
  const fallback = pool[0] || null;
  const empty = {
    model: fallback,
    cluster: "unknown",
    confidence: "low",
    reason: "fallback",
    alternates: [],
  };
  if (!fallback) {
    return { ...empty, model: null, parseError: "empty_pool" };
  }
  if (typeof text !== "string" || !text.trim()) {
    return { ...empty, reason: "empty_router_response", parseError: "empty" };
  }

  let raw = text.trim();
  // Strip markdown fences
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();

  // First {...} object
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) raw = brace[0];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try single-line trailing cleanup
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return { ...empty, reason: "invalid_json", parseError: "json" };
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { ...empty, reason: "invalid_shape", parseError: "shape" };
  }

  let model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  // Allow short names matching pool suffix — but only if unambiguous
  if (model && !pool.includes(model)) {
    const resolved = resolvePoolModel(model, pool);
    if (resolved) model = resolved;
  }
  if (!pool.includes(model)) {
    return {
      model: fallback,
      cluster: slugCluster(parsed.cluster),
      confidence: "low",
      reason: sanitizeReason(parsed.reason) || "model_not_in_pool",
      alternates: normalizeAlternates(parsed.alternates, pool, fallback),
      parseError: "not_in_pool",
    };
  }

  const confidence =
    parsed.confidence === "high" || parsed.confidence === "low"
      ? parsed.confidence
      : "low";

  return {
    model,
    cluster: slugCluster(parsed.cluster),
    confidence,
    reason: sanitizeReason(parsed.reason),
    alternates: normalizeAlternates(parsed.alternates, pool, model),
  };
}

/**
 * Resolve a short/partial model id against the pool.
 * Returns null when zero or multiple matches (never guess).
 * @param {string} model
 * @param {string[]} pool
 * @returns {string|null}
 */
export function resolvePoolModel(model, pool) {
  if (!model || !Array.isArray(pool)) return null;
  if (pool.includes(model)) return model;
  const matches = pool.filter(
    (p) => p === model || p.endsWith(`/${model}`) || p.split("/").pop() === model
  );
  if (matches.length === 1) return matches[0];
  return null;
}

function slugCluster(c) {
  if (typeof c !== "string" || !c.trim()) return "general";
  return (
    c
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "general"
  );
}

function sanitizeReason(r) {
  if (typeof r !== "string") return "";
  return r.slice(0, 280);
}

function normalizeAlternates(alts, pool, exclude) {
  if (!Array.isArray(alts)) return [];
  const out = [];
  for (const a of alts) {
    if (typeof a !== "string") continue;
    let m = a.trim();
    if (!pool.includes(m)) {
      const match = resolvePoolModel(m, pool);
      if (match) m = match;
      else continue;
    }
    if (m === exclude || out.includes(m)) continue;
    out.push(m);
  }
  return out.slice(0, 5);
}
