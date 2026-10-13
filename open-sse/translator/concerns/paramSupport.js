import { getCapabilitiesForModel } from "../../providers/capabilities.js";

// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

// Each rule: optional provider, regex match on model, list of params to drop.
// A param is removed only when it is present (!== undefined).
const STRIP_RULES = [
  // gpt-5.6-terra: reasoning unsupported upstream
  { match: /terra/i, drop: ["reasoning_effort"] },
  // All Claude models: temperature deprecated/rejected upstream (Anthropic 400). #1748
  { match: /claude/i, drop: ["temperature"] },
  // GitHub Copilot gpt-5.4: temperature unsupported.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  // GitHub Copilot Claude (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  { provider: "github", match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m), drop: ["thinking", "reasoning_effort"] },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // Strict OpenAI-compatible validators reject unknown assistant-message fields.
  // Clients driving reasoning models echo the prior turn's reasoning on every
  // assistant message; Groq 400s, Mistral 422s ("extra_forbidden"), Cerebras
  // 400s, knocking them out of every multi-turn combo. Providers that *require*
  // the field (DeepSeek, Kimi) go through reasoningContentInjector instead.
  { provider: "groq", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "mistral", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "cerebras", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  // OpenCode Go's relay rejects `response_format` for its deepseek family with HTTP
  // 400 — both json_schema and json_object — while glm / kimi / mimo / minimax /
  // qwen / grok / gpt on the same relay accept it. The rejection body is either a
  // bare model echo (`{"model":"deepseek-v4.1-flash"}`, which names neither the
  // field nor the reason) or "This response_format type is unavailable now", so a
  // client cannot classify it and keeps re-sending the field. Measured 2026-10-13
  // against /zen/go/v1/chat/completions with one key: 12/12 structured calls 400,
  // 4/4 identical calls without the field 200.
  { provider: "opencode-go", match: /^deepseek/i, drop: ["response_format"] },
];

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  if (!rule.match) return true;
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

function clampNumber(body, key, ceiling) {
  if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) {
    body[key] = ceiling;
  }
}

// Remove unsupported params from body in place; returns body.
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) delete body[key];
    }
    // Per-message field drop (assistant turns only — that is where clients replay reasoning).
    if (Array.isArray(rule.dropMessageFields) && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg || msg.role !== "assistant") continue;
        for (const key of rule.dropMessageFields) {
          if (msg[key] !== undefined) delete msg[key];
        }
      }
    }
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .map(b => (b?.type === "text" && typeof b.text === "string") ? b.text : "")
            .join("");
        }
      }
    }
    if (rule.clampToModelMaxOutput) {
      const ceiling = getCapabilitiesForModel(provider, model).maxOutput;
      if (Number.isFinite(ceiling) && ceiling > 0) {
        clampNumber(body, "max_tokens", ceiling);
        clampNumber(body, "max_completion_tokens", ceiling);
        clampNumber(body, "max_output_tokens", ceiling);
      }
    }
  }
  return body;
}
