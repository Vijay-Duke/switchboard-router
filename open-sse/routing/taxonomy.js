/**
 * Curated task taxonomy for Auto routing (Auto v2 — docs/switchboard/SPEC.md §7).
 *
 * The router prompt is constrained to this fixed enum, the optimizer aggregates
 * bandit stats per cluster, and the pre-generation policy fast path derives a
 * cluster guess from deterministic request signals. Free-form / legacy slugs
 * from older stored events are folded into the enum via LEGACY_CLUSTER_MAP so
 * historical data keeps aggregating; anything unknown collapses to "general".
 */

/** Fixed cluster enum — single source of truth. Order is display order. */
export const TASK_CLUSTERS = Object.freeze([
  "code-review",
  "code-generate",
  "mechanical-edit",
  "debug",
  "explain",
  "chat",
  "agentic-tools",
  "vision",
  "document",
  "general",
]);

/** Fallback cluster when a slug cannot be mapped. */
export const DEFAULT_CLUSTER = "general";

const CLUSTER_SET = new Set(TASK_CLUSTERS);

/** True when a slug is already a canonical taxonomy cluster. */
export function isTaxonomyCluster(slug) {
  return typeof slug === "string" && CLUSTER_SET.has(slug);
}

/**
 * Legacy / free-form slug → canonical cluster. Keys are pre-normalized
 * (lowercase, underscores). normalizeCluster() applies this after canonicalizing
 * separators, so `code review`, `code-review`, `code_review` all resolve.
 */
const LEGACY_CLUSTER_MAP = Object.freeze({
  // code-review
  review: "code-review",
  code_review: "code-review",
  codereview: "code-review",
  audit: "code-review",
  critique: "code-review",
  pr_review: "code-review",
  // code-generate
  coding: "code-generate",
  code: "code-generate",
  codegen: "code-generate",
  code_generation: "code-generate",
  code_generate: "code-generate",
  generate: "code-generate",
  implement: "code-generate",
  implementation: "code-generate",
  feature: "code-generate",
  write_code: "code-generate",
  // mechanical-edit
  edit: "mechanical-edit",
  mechanical: "mechanical-edit",
  refactor: "mechanical-edit",
  refactoring: "mechanical-edit",
  rename: "mechanical-edit",
  reformat: "mechanical-edit",
  format: "mechanical-edit",
  boilerplate: "mechanical-edit",
  // debug
  debug: "debug",
  debugging: "debug",
  bug: "debug",
  bugfix: "debug",
  error: "debug",
  fix: "debug",
  stacktrace: "debug",
  // explain
  explain: "explain",
  explanation: "explain",
  summarize: "explain",
  summary: "explain",
  describe: "explain",
  docs_explain: "explain",
  // chat
  chat: "chat",
  conversation: "chat",
  qa: "chat",
  question: "chat",
  general_chat: "chat",
  smalltalk: "chat",
  // agentic-tools
  agentic: "agentic-tools",
  agent: "agentic-tools",
  agentic_tools: "agentic-tools",
  tools: "agentic-tools",
  tool_use: "agentic-tools",
  orchestration: "agentic-tools",
  // vision
  vision: "vision",
  image: "vision",
  images: "vision",
  visual: "vision",
  ocr: "vision",
  // document
  document: "document",
  documents: "document",
  pdf: "document",
  file: "document",
  files: "document",
  doc: "document",
  // general
  general: "general",
  other: "general",
  misc: "general",
  unknown: "general",
});

/**
 * Normalize any slug (router output or legacy stored value) to the taxonomy.
 * @param {unknown} slug
 * @returns {string} canonical cluster (never empty)
 */
export function normalizeCluster(slug) {
  if (typeof slug !== "string") return DEFAULT_CLUSTER;
  const canon = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!canon) return DEFAULT_CLUSTER;
  // Direct hyphen form (canonical enum uses hyphens; canon uses underscores)
  const hyphen = canon.replace(/_/g, "-");
  if (CLUSTER_SET.has(hyphen)) return hyphen;
  if (LEGACY_CLUSTER_MAP[canon]) return LEGACY_CLUSTER_MAP[canon];
  // Substring heuristics for compound slugs (e.g. "python-code-review")
  if (canon.includes("review") || canon.includes("audit")) return "code-review";
  if (canon.includes("debug") || canon.includes("bug") || canon.includes("error")) return "debug";
  if (canon.includes("refactor") || canon.includes("rename") || canon.includes("format")) {
    return "mechanical-edit";
  }
  if (canon.includes("explain") || canon.includes("summ")) return "explain";
  if (canon.includes("vision") || canon.includes("image")) return "vision";
  if (canon.includes("document") || canon.includes("pdf") || canon.includes("file")) {
    return "document";
  }
  if (canon.includes("agent") || canon.includes("tool")) return "agentic-tools";
  if (canon.includes("chat") || canon.includes("convers")) return "chat";
  if (canon.includes("code") || canon.includes("gen") || canon.includes("implement")) {
    return "code-generate";
  }
  return DEFAULT_CLUSTER;
}

/**
 * Deterministic cluster guess from request signals for the pre-generation policy
 * fast path. Returns null when the request is ambiguous (caller falls through to
 * the cached route / router LLM). Deliberately conservative: a null here only
 * costs a router call, never a wrong pick.
 * @param {{ modalities?: string[], hasTools?: boolean, toolCountBand?: string, keywordHints?: string[] }} signals
 * @returns {string|null}
 */
export function deriveClusterGuess(signals) {
  if (!signals || typeof signals !== "object") return null;
  const modalities = Array.isArray(signals.modalities) ? signals.modalities : [];
  const hasVision = modalities.includes("vision");
  const hasPdf = modalities.includes("pdf");
  // Both modalities present → genuinely mixed → ambiguous (fall through to router).
  if (hasVision && hasPdf) return null;
  if (hasVision) return "vision";
  if (hasPdf) return "document";

  const band = signals.toolCountBand;
  if (signals.hasTools && (band === "4-10" || band === "10+")) return "agentic-tools";

  const hints = Array.isArray(signals.keywordHints) ? signals.keywordHints : [];
  // Only a single unambiguous keyword resolves; conflicting hints stay ambiguous.
  if (hints.length === 1) {
    if (hints[0] === "debug") return "debug";
    if (hints[0] === "explain") return "explain";
    if (hints[0] === "refactor") return "mechanical-edit";
    // "test" straddles code-generate / code-review → ambiguous
  }
  return null;
}
