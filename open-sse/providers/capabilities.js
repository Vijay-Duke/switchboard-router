// Model capabilities — what each model can read/do beyond plain text.
//
// Fallback order (first match wins), result merged over DEFAULT_CAPABILITIES:
//   1. PROVIDER_CAPABILITIES[provider][model]  — provider-specific override
//   2. MODEL_CAPABILITIES[model]               — canonical exact id (handles exceptions)
//   3. PATTERN_CAPABILITIES                     — glob match, ordered specific -> generic
//   4. DEFAULT_CAPABILITIES                     — safe floor (always returned)
//
// ── HOW TO ADD / UPDATE A MODEL ──────────────────────────────────────
// Authoritative data source: https://models.dev/api.json (145 providers, 4000+
// models, MIT). Each model exposes the exact fields we map below:
//   modalities.input  ["text","image","pdf","audio","video"] -> vision / pdf / audioInput / videoInput
//   modalities.output ["text","image","audio"]               -> imageOutput / audioOutput
//   reasoning   -> reasoning      tool_call    -> tools
//   limit.context -> contextWindow   limit.output -> maxOutput
// Look up the model id, then:
//   • If a PATTERN below already covers it correctly -> nothing to do.
//   • If it is an exception (pattern would mis-match) -> add an exact entry to
//     MODEL_CAPABILITIES (only the fields that differ from DEFAULT).
//   • If a whole new family -> add an ordered PATTERN (specific before generic).
// NOTE: models.dev has NO "search" flag (web search is a runtime tool, not a
// model spec); set `search` from vendor docs (Claude 4.x+, GPT-5.x/4o, Gemini
// 2.0+, Grok, Perplexity). Verify with: curl -s https://models.dev/api.json

import { getGeneratedCapabilities } from "./generated/loader.js";
import { matchPattern } from "./pricing.js";

/**
 * Safe floor — every resolved result is merged over this so consumers
 * never need null-checks. Most modern LLMs meet these limits.
 */
export const DEFAULT_CAPABILITIES = {
  // input modalities
  vision: false,        // read images
  pdf: false,           // read PDF / documents
  audioInput: false,    // read audio
  videoInput: false,    // read video
  // output modalities
  imageOutput: false,   // generate images
  audioOutput: false,   // generate audio
  // features
  search: false,        // built-in web search tool / grounding
  tools: true,          // function / tool calling
  reasoning: false,     // thinking / reasoning
  // thinking wire format (only meaningful when reasoning:true). null → derive from transport.format.
  // enum: openai|claude-adaptive|claude-budget|gemini-level|gemini-budget|zai|qwen|deepseek|kimi|minimax|hunyuan|step
  thinkingFormat: null,
  thinkingCanDisable: true,  // false → model cannot turn thinking off (clamp to min instead of disable)
  thinkingRange: null,       // { min, max } for budget formats; null = no clamp
  thinkingEffortSupported: false, // zai format only: model accepts a reasoning_effort level (GLM-5.2+; older GLM ignores it)
  // limits (tokens)
  contextWindow: 200000,
  maxOutput: 64000,
};

// User-added model metadata can carry dashboard service kinds instead of the
// runtime capability names used here. Map those typed model kinds into input /
// output capabilities so custom vision models are not treated as text-only.
const SERVICE_KIND_CAPABILITIES = {
  imageToText: { vision: true },
  image: { imageOutput: true },
  stt: { audioInput: true },
  tts: { audioOutput: true },
  embedding: { tools: false },
};

export function capabilitiesFromServiceKind(kind) {
  return SERVICE_KIND_CAPABILITIES[kind] || null;
}

/**
 * Canonical exact-id overrides — used for exceptions that patterns would
 * otherwise mis-match. Only declare deltas vs DEFAULT.
 */
export const MODEL_CAPABILITIES = {
  // Claude 4.6/4.7/4.8 and Kiro Sonnet 5 have 1M context + adaptive thinking (override generic claude pattern)
  "claude-opus-4.6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4.6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4-6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },

  // Gemini image-gen / OpenAI image / xai image variants
  "gpt-image-1":       { imageOutput: true, tools: false },

  // GLM vision variant (text GLM has no vision)
  "glm-4.6v":          { vision: true, reasoning: true, thinkingFormat: "zai", contextWindow: 128000 },

  // Qwen plain coder/text (no vision) — registry "vision-model" / "coder-model" aliases
  "vision-model":      { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
  "coder-model":       { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
};

/**
 * Provider-specific capability overrides. Keyed by provider alias/id.
 */
const CODEX_GPT_56_SOL_CAPS  = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 372000, maxOutput: 128000 };
const CODEX_GPT_56_DEFAULT_CAPS = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 };
const CODEX_EXTENDED_CAPS = { ...CODEX_GPT_56_DEFAULT_CAPS, contextWindow: 872000 };

export const PROVIDER_CAPABILITIES = {
  // NVIDIA NIM is OpenAI-compatible → rejects MiniMax/GLM native `thinking` field.
  // Force openai reasoning_effort format for its reasoning models. #issue
  "nvidia": {
    "minimaxai/minimax-m2.7": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 },
    "minimaxai/minimax-m3": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 131072 },
    "z-ai/glm-5.2": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 128000 },
    "deepseek-ai/deepseek-v4-pro": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "deepseek-ai/deepseek-v4-flash": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
  },
  // CodeBuddy.cn — authoritative per-model metadata from the gateway's model
  // config (contextWindow=maxInputTokens, maxOutput=maxOutputTokens, vision=
  // supportsImages). Every model reasons via OpenAI-style reasoning_effort
  // (see registry thinkingFormat). For thinkingCanDisable use the server's
  // reasoning.canDisableThinking flag — see the note in the codebuddy-cn block
  // below; it is NOT the inverse of onlyReasoning.
  "codebuddy-cn": {
    "glm-5.2":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.1":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    // maxOutput 64000 per both the plugin-baked fallback and the live server
    // table (the old 38000 had no source and truncated output).
    "glm-5v-turbo":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 64000 },
    "glm-4.7":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "minimax-m3":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 128000 },
    "kimi-k2.7":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.6":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    // Per-model values mirror the server's product-config payload (the plugin
    // fetches it from copilot.tencent.com; the `models[]` entries carry
    // maxInputTokens/maxOutputTokens/supportsImages). contextWindow =
    // maxInputTokens, maxOutput = maxOutputTokens. Where the server and the
    // plugin-baked fallback disagree, the server table wins.
    // ⚠️ thinkingCanDisable maps to the server's reasoning.canDisableThinking —
    // it is NOT the inverse of onlyReasoning. onlyReasoning means "thinking is
    // on by default"; canDisableThinking means "it CAN be turned off". glm-5.3
    // and glm-5.3-flash are onlyReasoning:true BUT canDisableThinking:true, so
    // their thinking is switchable; the hy* models are forced always-on.
    "hy3":                { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "hy4-preview":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 64000 },
    "glm-5.3":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.3-flash":      { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 32000 },
    "kimi-k3-1":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 32000 },
    "deepseek-v4-pro":    { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 50000 },
    // deepseek-v4.1-flash replaces v4-flash (dropped from the server list;
    // the old endpoint still answers 200 but the published list is the
    // contract). maxOutput 128000 per the server's product-config payload.
    "deepseek-v4.1-flash": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 128000 },
  },
  // Codex (ChatGPT OAuth) caps the default window below the API model's;
  // the "[1m]" registry variants map to the same upstream id with an
  // extended 872k window (codex-rs/models-manager/models.json).
  "codex": {
    "gpt-6-astra[1m]":           CODEX_EXTENDED_CAPS,
    "gpt-6-sol[1m]":             CODEX_EXTENDED_CAPS,
    "gpt-6-luna[1m]":            CODEX_EXTENDED_CAPS,
    "gpt-5.6-sol[1m]":           CODEX_EXTENDED_CAPS,
    "gpt-5.6-terra[1m]":         CODEX_EXTENDED_CAPS,
    "gpt-5.6-luna[1m]":          CODEX_EXTENDED_CAPS,
    "gpt-5.6-sol":               CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-sol-review":        CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-terra":             CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-terra-review":      CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna":              CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna-review":       CODEX_GPT_56_DEFAULT_CAPS,
  },
};
// The registry alias resolves to the same table.
PROVIDER_CAPABILITIES.cx = PROVIDER_CAPABILITIES.codex;

/**
 * Pattern fallback — glob (* = wildcard), matched case-insensitively and
 * anchored (^...$) so a pattern must match the full model id. ORDER MATTERS:
 * vision/specific variants first, text-only/generic families last, to avoid
 * a broad family pattern swallowing an exception (e.g. glm-4.6v vs glm-5).
 */
export const PATTERN_CAPABILITIES = [
  // ── Claude (4.6+ = adaptive thinking; older/haiku = budget) ──────
  { pattern: "*claude*opus-4.6*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.7*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.8*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.6*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.7*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*haiku*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*opus*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*fable*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*mythos*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude-3*",      caps: { vision: true } },
  { pattern: "*claude*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },

  // ── Gemini (all 2.0+ multimodal + google_search grounding, 1M ctx) ─
  { pattern: "*gemini*image*",  caps: { vision: true, imageOutput: true, contextWindow: 1048576 } },
  { pattern: "*gemini-3*pro*",  caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65535 } },
  { pattern: "*gemini-3*",      caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2.5*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-budget", thinkingRange: { min: 0, max: 24576 }, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2*",      caps: { vision: true, audioInput: true, videoInput: true, search: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini*",        caps: { vision: true, search: true, contextWindow: 1048576 } },
  { pattern: "*gemma*",         caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*nanobanana*",    caps: { vision: true, imageOutput: true } },

  // ── OpenAI GPT-6 family (vision + thinking + web search) ─────────
  // Image variants ("-image" suffix) are image models, not chat models — first
  // match wins, so they must precede the generic family entry below.
  { pattern: "*gpt-6*image*",   caps: { imageOutput: true } },
  { pattern: "*gpt-6*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 } },

  // ── OpenAI GPT-5.x (vision + thinking + web search) ──────────────
  { pattern: "*gpt-5*image*",   caps: { imageOutput: true } },
  { pattern: "*gpt-5*codex*",   caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-4o*",        caps: { vision: true, search: true, contextWindow: 128000, maxOutput: 16384 } },
  { pattern: "*gpt-4.1*",       caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
  { pattern: "*gpt-4-turbo*",   caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*gpt-4*",         caps: { contextWindow: 128000 } },
  { pattern: "*gpt-3.5*",       caps: { contextWindow: 16385, maxOutput: 4096 } },
  { pattern: "*gpt-oss*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },

  // ── OpenAI o-series (reasoning, vision) ──────────────────────────
  { pattern: "*o1-mini*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },
  { pattern: "*o1*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o4*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },

  // ── Grok (vision + Live Search) ──────────────────────────────────
  { pattern: "*grok*image*",    caps: { imageOutput: true } },
  { pattern: "*grok-code*",     caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000 } },
  { pattern: "*grok-4*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },
  { pattern: "*grok-3*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 131072 } },
  { pattern: "*grok*",          caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },

  // ── Qwen (3.5+ = native vision/video; coder & max = text-only; QwQ = thinking-only) ─
  { pattern: "*qwen*vl*",       caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwen*omni*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*coder*",    caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 } },
  { pattern: "*qwen*max*",      caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.5*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.6*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.7*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*plus*",     caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*235b*",     caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwq*",           caps: { reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 131072 } },
  { pattern: "*qwen*",          caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },

  // ── Kimi (enabled→reasoning_effort; K2.7-code cannot disable) ─────
  { pattern: "*kimi*k2.7*code*", caps: { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 262144 } },
  // Kimi K3 family (K3, K3.1 Pro): 1M context, thinking always on.
  { pattern: "*kimi*k3*",       caps: { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*kimi*k2*",       caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*kimi*",          caps: { reasoning: true, thinkingFormat: "kimi", contextWindow: 262144 } },

  // ── GLM / Z.ai (thinking.enabled; disable via enable_thinking:false) ─
  // reasoning_effort is only read by z.ai from GLM-5.2 onward (docs.z.ai/guides/capabilities/thinking) —
  // older GLM (4.x, 5.0, 5.1, 5-turbo, 5v-turbo) ignore it, so gate it per exact version, not the "*glm-5*" catch-all.
  { pattern: "*glm-5.3*",       caps: { reasoning: true, thinkingFormat: "zai", thinkingEffortSupported: true, contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-5.2*",       caps: { reasoning: true, thinkingFormat: "zai", thinkingEffortSupported: true, contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-5*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4.7*",       caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },
  { pattern: "*glm*",           caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },

  // ── DeepSeek (thinking.enabled + reasoning_effort; r1 = thinking-only) ─
  // v4.1+ has real image input (probed live on Alibaba MaaS: correct color
  // read from a PNG). v4-pro / v4-flash-0731 accept image blocks but ignore
  // them (answered "Unknown"), so vision stays scoped to v4.* dotted releases.
  { pattern: "*deepseek-v4.*",  caps: { vision: true, reasoning: true, thinkingFormat: "deepseek", thinkingEffortSupported: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*deepseek-v4*",   caps: { reasoning: true, thinkingFormat: "deepseek", thinkingEffortSupported: true, contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*reasoner*",      caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-r*",    caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-chat*", caps: { contextWindow: 128000 } },
  { pattern: "*deepseek*",      caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000 } },

  // ── MiniMax (M3 = adaptive; M2.x cannot disable) ─────────────────
  { pattern: "*minimax*image*", caps: { imageOutput: true } },
  { pattern: "*minimax-m3*",    caps: { vision: true, reasoning: true, thinkingFormat: "minimax", contextWindow: 1048576, maxOutput: 512000 } },
  { pattern: "*minimax-m2.7*",  caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax*",       caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 } },

  // ── Xiaomi MiMo (vision, 1M / 262K ctx) ──────────────────────────
  { pattern: "*mimo*v2.5*",     caps: { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*omni*",     caps: { vision: true, audioInput: true, contextWindow: 262144, maxOutput: 131072 } },
  { pattern: "*mimo*",          caps: { vision: true, contextWindow: 262144, maxOutput: 131072 } },

  // ── Llama (4 = vision/1M; 3.x = text-only/128K) ──────────────────
  { pattern: "*llama-4*",       caps: { vision: true, contextWindow: 1000000 } },
  { pattern: "*llama*",         caps: { contextWindow: 128000 } },

  // ── Mistral (Large 3 = vision/256K; codestral text) ──────────────
  { pattern: "*codestral*",     caps: { contextWindow: 256000 } },
  { pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000 } },
  { pattern: "*mistral*",       caps: { contextWindow: 128000 } },

  // ── Cohere (Command A Vision = vision; others text) ──────────────
  { pattern: "*command-a-vision*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*command*",       caps: { contextWindow: 128000 } },

  // ── Perplexity (web search native) ───────────────────────────────
  { pattern: "*sonar*",         caps: { search: true, contextWindow: 128000 } },
  { pattern: "*pplx*",          caps: { search: true, contextWindow: 128000 } },
  { pattern: "*perplexity*",    caps: { search: true, contextWindow: 128000 } },

  // ── Meta Muse (vision + reasoning, 1M ctx) ────────────────────────
  { pattern: "*muse-spark*",    caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*muse*",          caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 65536 } },

  // ── Others ───────────────────────────────────────────────────────
  { pattern: "*hunyuan*",       caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "hy3*",            caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*step-*",         caps: { reasoning: true, thinkingFormat: "step", contextWindow: 128000 } },
  { pattern: "*nemotron*",      caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*ling-*",         caps: { reasoning: true, contextWindow: 128000 } },
];

/**
 * Resolve explicitly maintained capability deltas without applying defaults.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object|null} explicit capability delta, if matched
 */
export function resolveHandCaps(provider, model) {
  const providerCaps = PROVIDER_CAPABILITIES[provider]?.[model];
  if (providerCaps) return providerCaps;

  // Strip vendor prefix: "anthropic/claude-opus-4.7" -> "claude-opus-4.7".
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  const modelCaps = MODEL_CAPABILITIES[baseModel] || MODEL_CAPABILITIES[model];
  if (modelCaps) return modelCaps;

  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel || model)) return caps;
  }

  return null;
}

/**
 * Resolve generated and explicitly maintained capability deltas, merged over
 * DEFAULT_CAPABILITIES so the result is always complete.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object} full capabilities object
 */
export function getCapabilitiesForModel(provider, model) {
  if (!model) return { ...DEFAULT_CAPABILITIES };

  const hand = resolveHandCaps(provider, model);
  const gen = getGeneratedCapabilities(model);
  return { ...DEFAULT_CAPABILITIES, ...(gen || {}), ...(hand || {}) };
}

/**
 * Advertised reasoning-effort levels per model family, served on /v1/models
 * for connections whose upstream does not relay capabilities (e.g.
 * Anthropic-compatible nodes facing api.anthropic.com, whose catalog carries
 * no capability objects). Live upstream capabilities always win (see the
 * merge in the models route). Levels mirror the vendors' effort enums;
 * families without evidence stay unlisted (no advertisement).
 * ORDER MATTERS: specific families before generic ones.
 */
export const EFFORT_LEVEL_PATTERNS = [
  // Muse Spark (Meta): top tier carries max (registry muse.js thinking.levels).
  { pattern: "*muse-spark*", levels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { pattern: "*muse-wonder*", levels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  // Claude 5.x / late 4.x: five levels (matches the live Claude Code catalog)
  { pattern: "*claude*opus-5*",     levels: ["low", "medium", "high", "xhigh", "max"] },
  { pattern: "*claude*sonnet-5*",   levels: ["low", "medium", "high", "xhigh", "max"] },
  { pattern: "*claude*haiku-5-5*",  levels: ["low", "medium", "high", "xhigh", "max"] },
  { pattern: "*claude*fable-5*",    levels: ["low", "medium", "high", "xhigh", "max"] },
  { pattern: "*claude*opus-4-8*",   levels: ["low", "medium", "high", "xhigh", "max"] },
  { pattern: "*claude*opus-4-7*",   levels: ["low", "medium", "high", "xhigh", "max"] },
  // Claude 4.6: no xhigh tier. Opus 4.5: low/medium/high only (per vendor docs).
  { pattern: "*claude*opus-4-6*",   levels: ["low", "medium", "high", "max"] },
  { pattern: "*claude*opus-4-5*",   levels: ["low", "medium", "high"] },
  { pattern: "*claude*sonnet-4-6*", levels: ["low", "medium", "high", "max"] },
  // DeepSeek V4 family (thinkingFormat deepseek → high + max)
  { pattern: "*deepseek-v4*", levels: ["high", "max"] },
];

/**
 * Build the advertised `{ effort }` capabilities object for a model id,
 * or null when the family has no known effort support. Accepts
 * `alias/model` or bare ids; matching is case-insensitive.
 */
export function effortCapabilitiesForModelId(modelId) {
  if (typeof modelId !== "string" || !modelId) return null;
  const bare = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  const hit = EFFORT_LEVEL_PATTERNS.find(({ pattern }) => matchPattern(pattern, bare));
  if (!hit) return null;
  const effort = { supported: true };
  for (const level of hit.levels) effort[level] = { supported: true };
  return { effort };
}

function supportedEffortLevels(effort) {
  if (!effort || typeof effort !== "object" || effort.supported !== true) return null;
  const levels = Object.keys(effort).filter((level) => level !== "supported"
    && effort[level] && effort[level].supported === true);
  return levels.length > 0 ? levels : null;
}

const REASONING_LIST_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Synthesize an effort block from upstream list dialects that carry levels
 * without an `effort{}` block: OpenCode-style `reasoning.effort[]` and
 * OpenRouter-style `reasoning.supported_efforts[]`. ("none" is a disable
 * claim, not an advertised level.) Returns null when no usable list exists.
 */
function effortFromReasoningList(upstreamCaps) {
  const reasoning = upstreamCaps && typeof upstreamCaps === "object" ? upstreamCaps.reasoning : null;
  if (!reasoning || typeof reasoning !== "object") return null;
  const list = Array.isArray(reasoning.effort) ? reasoning.effort
    : Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts
      : null;
  if (!list) return null;
  const effort = { supported: true };
  let found = false;
  for (const raw of list) {
    const level = String(raw || "").toLowerCase();
    if (REASONING_LIST_LEVELS.has(level)) {
      effort[level] = { supported: true };
      found = true;
    }
  }
  return found ? effort : null;
}

/**
 * Reconcile an upstream-advertised effort block with the statically-known
 * one. Upstream catalogs may attach one generic block to every model, so
 * when both sides claim levels only their intersection is advertised
 * (upstream level objects preserved). An explicit upstream ban wins
 * outright; with no overlap the upstream claim is kept (static patterns
 * may predate renamed levels). Returns `{ effort }` or null.
 */
export function resolveEffortCapabilities(upstreamCaps, staticCaps) {
  let upEffort = upstreamCaps && typeof upstreamCaps === "object" ? upstreamCaps.effort : null;
  if (upEffort && upEffort.supported === false) return { effort: upEffort };
  if (!supportedEffortLevels(upEffort)) {
    upEffort = effortFromReasoningList(upstreamCaps) || upEffort;
  }
  const stEffort = staticCaps && typeof staticCaps === "object" ? staticCaps.effort : null;
  const upLevels = supportedEffortLevels(upEffort);
  const stLevels = supportedEffortLevels(stEffort);
  if (!upLevels && !stLevels) return null;
  if (!upLevels) return { effort: stEffort };
  if (!stLevels) return { effort: upEffort };
  const agreed = stLevels.filter((level) => upLevels.includes(level));
  if (agreed.length === 0) return { effort: upEffort };
  const effort = { supported: true };
  for (const level of agreed) effort[level] = { ...upEffort[level] };
  return { effort };
}

const EFFORT_UNION_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Union the advertised effort levels of several capability objects.
 * Combo semantics: a combo CAN reason at a level when at least one member
 * can, because routing/fallback picks (and clamps for) one member at a
 * time. Explicit bans on individual members never suppress a supporting
 * member. Returns `{ effort }` in canonical level order (unknown future
 * levels last, in first-seen order), or null when nobody claims a level.
 */
export function unionEffortCapabilities(capsList = []) {
  const byLevel = new Map();
  for (const caps of capsList || []) {
    const effort = caps && typeof caps === "object" ? caps.effort : null;
    if (!effort || typeof effort !== "object" || effort.supported === false) continue;
    for (const level of supportedEffortLevels(effort) || []) {
      if (!byLevel.has(level)) byLevel.set(level, effort[level]);
    }
  }
  if (byLevel.size === 0) return null;
  const ordered = [
    ...EFFORT_UNION_ORDER.filter((level) => byLevel.has(level)),
    ...[...byLevel.keys()].filter((level) => !EFFORT_UNION_ORDER.includes(level)),
  ];
  const effort = { supported: true };
  for (const level of ordered) {
    const value = byLevel.get(level);
    effort[level] = value && typeof value === "object"
      ? { ...value, supported: true }
      : { supported: true };
  }
  return { effort };
}
