import { describe, it, expect } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { getTargetFormat } from "../../open-sse/services/provider.js";

// Regression: BaseExecutor/DefaultExecutor injected stream_options into every
// streaming body with a messages array — including claude-format bodies, which
// Anthropic rejects with 400 "stream_options: Extra inputs are not permitted".
// Injection is OpenAI-wire-only now (openai/ollama formats).
describe("stream_options injection is gated to OpenAI wire formats", () => {
  it("injects for an OpenAI-format provider (usage tracking intact)", () => {
    const ex = getExecutor("opencode-go");
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest("glm-4", body, true, {});
    expect(out.stream_options?.include_usage).toBe(true);
  });

  it("does not inject for the claude provider (DefaultExecutor, claude wire)", () => {
    expect(PROVIDERS.claude?.format).toBe("claude");
    const ex = getExecutor("claude");
    const body = { model: "claude-opus-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest("claude-opus-5", body, true, {});
    expect(out.stream_options).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("stream_options");
  });

  it("does not inject for anthropic-format compatible nodes", () => {
    // Regression (v0.9.28 follow-up): DefaultExecutor's this.config comes from
    // the static PROVIDERS map, where dynamic anthropic-compatible-* nodes
    // don't exist — the openai fallback made the gate inject stream_options
    // into claude-wire bodies. getTargetFormat resolves them correctly.
    const compatProvider = "anthropic-compatible-95133332-5be3-4f4b-9a0e-4b117a7858e0";
    expect(getTargetFormat(compatProvider, {})).toBe("claude");
    const ex = getExecutor(compatProvider);
    const body = { max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest("claude-opus-5", body, true, {});
    expect(out.stream_options).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("stream_options");
  });

  it("still sets body.stream for claude streaming (only the OpenAI-ism is gated)", () => {
    const ex = getExecutor("claude");
    const body = { max_tokens: 8, messages: [{ role: "user", content: "hi" }], stream: true };
    const out = ex.transformRequest("claude-opus-5", body, true, {});
    expect(out.stream).toBe(true);
  });
});
