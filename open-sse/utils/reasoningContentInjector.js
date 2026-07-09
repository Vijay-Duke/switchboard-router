// Some thinking-mode providers (DeepSeek, Kimi, MiniMax, ...) require reasoning_content
// to be echoed back on assistant messages. Clients in OpenAI format don't send it,
// so we inject a non-empty placeholder to satisfy upstream validation.
import { PROVIDERS } from "../config/providers.js";

const PLACEHOLDER = " ";

// Provider-level rules derive from registry transport.reasoningInject (single source)
const providerRuleFor = (provider) => PROVIDERS[provider]?.reasoningInject;

// Model-level rules: matched by predicate against model id
const MODEL_RULES = [
  { match: m => /^kimi-/i.test(m || ""), scope: "toolCalls" },
  { match: m => /deepseek/i.test(m || ""), scope: "all" }
];

const DEEPSEEK_V4_PRO = "deepseek-v4-pro";
const DEEPSEEK_V4_PRO_ALIASES = {
  [`${DEEPSEEK_V4_PRO}-max`]: {
    thinkingType: "enabled",
    reasoningEffort: "max"
  },
  [`${DEEPSEEK_V4_PRO}-none`]: {
    thinkingType: "disabled",
    reasoningEffort: null
  }
};

function shouldInject(message, scope) {
  if (message?.role !== "assistant") return false;
  const rc = message.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) return false;
  if (scope === "toolCalls") return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return true;
}

function applyRule(body, rule) {
  if (!rule || !body?.messages) return body;
  // Skip Claude/Anthropic-shaped bodies (messages with tool_use/tool_result blocks
  // or top-level system string). injecting OpenAI reasoning_content there causes
  // MiniMax/Claude-format 400s (wave8).
  if (isClaudeShapedBody(body)) return body;
  const messages = body.messages.map(m =>
    shouldInject(m, rule.scope) ? { ...m, reasoning_content: PLACEHOLDER } : m
  );
  return { ...body, messages };
}

function isClaudeShapedBody(body) {
  if (typeof body.system === "string" || Array.isArray(body.system)) return true;
  if (!Array.isArray(body.messages)) return false;
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "tool_use" || block?.type === "tool_result" || block?.type === "thinking") {
        return true;
      }
    }
  }
  return false;
}

function applyDeepSeekV4ProAlias({ provider, model, body }) {
  const alias = DEEPSEEK_V4_PRO_ALIASES[model];
  if (provider !== "deepseek" || !alias || !body) return body;

  // Wire-level thinking (JSON body). Do NOT use extra_body — that is a Python SDK
  // concept and is never flattened by our executors (raw JSON.stringify).
  const nextBody = {
    ...body,
    model: DEEPSEEK_V4_PRO,
    thinking: { type: alias.thinkingType },
  };

  // Drop any stale SDK-shaped nest so it can't confuse proxies
  if (nextBody.extra_body?.thinking) {
    const { thinking: _t, ...restExtra } = nextBody.extra_body;
    if (Object.keys(restExtra).length === 0) delete nextBody.extra_body;
    else nextBody.extra_body = restExtra;
  }

  if (alias.reasoningEffort) {
    nextBody.reasoning_effort = alias.reasoningEffort;
  } else {
    delete nextBody.reasoning_effort;
  }

  return nextBody;
}

export function injectReasoningContent({ provider, model, body }) {
  const providerRule = providerRuleFor(provider);
  const modelRule = MODEL_RULES.find(r => r.match(model));
  const rule = providerRule || modelRule;
  const nextBody = applyDeepSeekV4ProAlias({ provider, model, body });
  return applyRule(nextBody, rule);
}
