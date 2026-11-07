// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { lookupCatalogReasoning } from "./reasoningPriors.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget, claude-adaptive
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  openai: L.openai,
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  deepseek: L.hiMax,
  // command-code sends params.reasoning_effort verbatim, including max.
  commandcode: ["none", "low", "medium", "high", "xhigh", "max"],
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
};

// Opus/Sonnet 4.6 lack xhigh (Anthropic + Kiro docs) — keep the 4-level+max set.
const CLAUDE_NO_XHIGH = ["none", "low", "medium", "high", "max"];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
const PATTERN_THINKING = [
  // Gemini 4 (Argon) rejects "minimal" with 400 — LOW is the floor; cannot disable thinking.
  { pattern: "*gemini-4*", levels: ["low", "medium", "high"] },
  { pattern: "*claude*4.6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*claude*4-6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  // DeepSeek v4.* (Alibaba MaaS, probed live): effort low|medium|high|xhigh|max
  // all 200 via output_config.effort; "none" is a 400 on the anthropic route
  // (disable thinking instead). none kept for the picker = disable. Scoped to
  // the Alibaba lanes: DeepSeek's own API and Command Code only expose high|max.
  { provider: "alicode", pattern: "*deepseek-v4.*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { provider: "alicode-intl", pattern: "*deepseek-v4.*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  // codebuddy-cn per-model effort sets — the server's product-config payload
  // publishes `reasoning.supportedEfforts` per model. NOTE: the chat endpoint
  // accepts any level you send (probed none/minimal/low/medium/high/xhigh/max
  // → all 200), but values outside a model's supportedEfforts are silently
  // clamped, so the declared set stays authoritative for the picker. Models
  // that publish no supportedEfforts (glm-5.1 / glm-5v-turbo / kimi-k2.x /
  // kimi-k3-1 / minimax-m3) fall through to the openai format default.
  { provider: "codebuddy-cn", pattern: "glm-5.3*",     levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.2",      levels: ["high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "hy3*",         levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4*",         levels: ["high"] },
];

/**
 * Wire effort level an upstream accepts for a Pi level, or null when the
 * upstream has no vocabulary for it. Effort-capable (openai) gateways accept
 * `max` as an alias for their top tier — the translator clamps max→xhigh —
 * so it round-trips instead of hiding the level in Pi's picker.
 * @param {string[] | null | undefined} levels
 * @param {string} level Pi level key (low|medium|high|xhigh|max)
 */
export function effortWireLevel(levels, level) {
  if (!Array.isArray(levels)) return null;
  if (levels.includes(level)) return level;
  if (level === "max" && levels.includes("xhigh")) return "max";
  return null;
}

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  // Provider-scoped entries (e.g. codebuddy-cn's published supportedEfforts)
  // must not leak onto the same model id served by another provider.
  const hit = PATTERN_THINKING.find((p) => (!p.provider || p.provider === provider) && matchPattern(p.pattern, model));
  let levels = hit?.levels || null;
  let prior = null;
  if (!levels) {
    const formatLevels = FORMAT_LEVELS[caps.thinkingFormat] || L.base;
    // Binary format defaults carry no per-model information and go stale
    // when a vendor ships real tiers (ZAI GLM-5.3 gained low/high/max).
    // Upgrade ONLY those from synced catalog priors (models.dev +
    // OpenRouter). Budget-mapped base formats (qwen/step/…) keep their
    // vocabulary: its size drives level→budget math in the translator, and
    // effort priors must not silently change sent thinking budgets.
    if (formatLevels === L.onOff) {
      prior = lookupCatalogReasoning(provider, model);
      if (Array.isArray(prior?.levels) && prior.levels.length > 0) {
        levels = ["none", ...prior.levels];
      }
    }
    if (!levels) levels = formatLevels;
  }
  if (caps.thinkingCanDisable === false || prior?.mandatory === true) {
    levels = levels.filter((l) => l !== "none");
  }
  return levels;
}

/**
 * Build `/v1/models` effort capabilities from registry thinking levels when
 * EFFORT_LEVEL_PATTERNS has no explicit family entry.
 * @param {string|null} provider
 * @param {string} model
 */
export function effortCapabilitiesFromThinkingLevels(provider, model) {
  const levels = getThinkingLevels(provider, model);
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const advertised = levels.filter((level) => level !== "none" && level !== "thinking");
  if (advertised.length === 0) return null;
  const effort = { supported: true };
  for (const level of advertised) effort[level] = { supported: true };
  return { effort };
}
