import { describe, expect, it } from "vitest";
import {
  PROVIDER_MODELS,
  getModelSupportedFormats,
  getModelTargetFormat,
} from "../../open-sse/config/providerModels.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import opencodeGoRegistry from "../../open-sse/providers/registry/opencode-go.js";

const CHAT_MODELS = [
  // Registry order is display order: deepseek-flash (V4.1) leads the catalog.
  "deepseek-flash",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  // OpenCode Go docs' endpoint table currently says kimi-k2.7, but its
  // config example and the live API use kimi-k2.7-code.
  "kimi-k2.7-code",
  "kimi-k2.6",
  "kimi-k2.5",
  "kimi-k3",
  "kimi-k3.1-pro",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4.1-flash",
  "longcat-2.0",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2-pro",
  "mimo-v2-omni",
];

const MESSAGES_MODELS = [
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "space-bunny-free",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
];

// Chat-lane models listed after the Messages block in the registry
const TRAILING_CHAT_MODELS = ["hy4-preview", "hy3", "hy3-preview", "omen-alpha"];

// Served by /zen/go/v1/responses only
const RESPONSES_ONLY_MODELS = ["grok-4.7", "grok-4.6", "grok-4.5", "gpt-5.6-luna", "gpt-6-luna"];

const MULTI_TRANSPORT_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash"];

describe("OpenCode Go official model catalog", () => {
  it("matches the documented OpenCode Go model IDs", () => {
    const ids = (PROVIDER_MODELS["opencode-go"] || []).map((model) => model.id);

    expect(ids).toEqual([...CHAT_MODELS, ...MESSAGES_MODELS, ...TRAILING_CHAT_MODELS, ...RESPONSES_ONLY_MODELS]);
  });

  it("marks documented Qwen and MiniMax models as Anthropic messages format", () => {
    for (const model of MESSAGES_MODELS) {
      expect(getModelTargetFormat("opencode-go", model)).toBe("claude");
    }
  });

  it("keeps GLM, Kimi, DeepSeek, and MiMo on OpenAI-compatible chat format", () => {
    for (const model of [...CHAT_MODELS, ...TRAILING_CHAT_MODELS]) {
      expect(getModelTargetFormat("opencode-go", model)).toBeNull();
    }
  });

  it("pins responses-only models to the openai-responses target", () => {
    for (const model of RESPONSES_ONLY_MODELS) {
      expect(getModelTargetFormat("opencode-go", model)).toBe("openai-responses");
      expect(getModelSupportedFormats("opencode-go", model)).toEqual(["openai-responses"]);
    }
  });

  it("declares the native transports supported by each model", () => {
    for (const model of [...CHAT_MODELS, ...TRAILING_CHAT_MODELS].filter((id) => !MULTI_TRANSPORT_MODELS.includes(id))) {
      expect(getModelSupportedFormats("opencode-go", model)).toEqual(["openai"]);
    }
    for (const model of MESSAGES_MODELS) {
      expect(getModelSupportedFormats("opencode-go", model)).toEqual(["openai", "claude"]);
    }
    for (const model of MULTI_TRANSPORT_MODELS) {
      expect(getModelSupportedFormats("opencode-go", model)).toEqual([
        "openai",
        "claude",
        "openai-responses",
      ]);
    }
  });
});

describe("OpenCode Go family fallback for live-catalogue ids", () => {
  it("keeps unknown ids on the endpoint lane of their family", () => {
    expect(getModelTargetFormat("opencode-go", "grok-5")).toBe("openai-responses");
    expect(getModelSupportedFormats("opencode-go", "gpt-7-luna")).toEqual(["openai-responses"]);
    expect(getModelTargetFormat("opencode-go", "qwen4-max")).toBe("claude");
    expect(getModelSupportedFormats("opencode-go", "minimax-m4")).toEqual(["openai", "claude"]);
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4.2-flash")).toEqual(["openai", "claude", "openai-responses"]);
    // anything else defaults to the chat lane, never the sourceFormat-matched transport
    expect(getModelTargetFormat("opencode-go", "brand-new-model")).toBeNull();
    expect(getModelSupportedFormats("opencode-go", "brand-new-model")).toEqual(["openai"]);
    expect(resolveTransport("opencode-go", "claude", getModelSupportedFormats("opencode-go", "brand-new-model"))).toBeNull();
  });

  it("does not apply the OpenCode family regex to other providers", () => {
    expect(getModelSupportedFormats("deepseek", "grok-5")).toBeNull();
    expect(getModelTargetFormat("deepseek", "grok-5")).toBeNull();
  });

  it("declares the live catalogue fetcher and passthrough", () => {
    expect(opencodeGoRegistry.passthroughModels).toBe(true);
    expect(opencodeGoRegistry.modelsFetcher).toEqual({ url: "https://opencode.ai/zen/go/v1/models", type: "opencode-go" });
  });
});

describe("OpenCode Go endpoint routing", () => {
  it("uses the stateless config-driven executor", () => {
    expect(hasSpecializedExecutor("opencode-go")).toBe(false);
    expect(getExecutor("opencode-go")).toBeInstanceOf(DefaultExecutor);
  });

  it("selects a matching native transport only when the model supports it", () => {
    const nativeTransport = (model, sourceFormat) => resolveTransport(
      "opencode-go",
      sourceFormat,
      getModelSupportedFormats("opencode-go", model),
    );

    expect(nativeTransport("deepseek-v4-pro", "openai-responses")?.baseUrl)
      .toBe("https://opencode.ai/zen/go/v1/responses");
    expect(nativeTransport("minimax-m3", "claude")?.baseUrl)
      .toBe("https://opencode.ai/zen/go/v1/messages");
    expect(nativeTransport("minimax-m3", "openai")?.baseUrl)
      .toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(nativeTransport("glm-5.2", "claude")).toBeNull();
    expect(nativeTransport("minimax-m3", "openai-responses")).toBeNull();
    for (const model of RESPONSES_ONLY_MODELS) {
      expect(nativeTransport(model, "openai-responses")?.baseUrl)
        .toBe("https://opencode.ai/zen/go/v1/responses");
      expect(nativeTransport(model, "claude")).toBeNull();
      expect(nativeTransport(model, "openai")).toBeNull();
    }
  });

  it("uses the selected transport URL and authentication contract", () => {
    const executor = getExecutor("opencode-go");
    const credentials = { apiKey: "sk-test" };

    for (const [format, baseUrl, authHeader] of [
      ["openai", "https://opencode.ai/zen/go/v1/chat/completions", "Authorization"],
      ["claude", "https://opencode.ai/zen/go/v1/messages", "x-api-key"],
      ["openai-responses", "https://opencode.ai/zen/go/v1/responses", "Authorization"],
    ]) {
      credentials.runtimeTransport = resolveTransport("opencode-go", format, [format]);
      expect(executor.buildUrl("deepseek-v4-pro", true, 0, credentials)).toBe(baseUrl);
      const headers = executor.buildHeaders(credentials, false);
      expect(headers[authHeader]).toBe(authHeader === "Authorization" ? "Bearer sk-test" : "sk-test");
      if (format === "claude") expect(headers["anthropic-version"]).toBeDefined();
    }
  });

  it("routes Qwen and MiniMax models to the messages endpoint with x-api-key auth", () => {
    const executor = getExecutor("opencode-go");

    for (const model of MESSAGES_MODELS) {
      const credentials = {
        apiKey: "sk-test",
        runtimeTransport: resolveTransport("opencode-go", "claude", getModelSupportedFormats("opencode-go", model)),
      };
      expect(executor.buildUrl(model, true, 0, credentials)).toBe("https://opencode.ai/zen/go/v1/messages");
      const headers = executor.buildHeaders(credentials, false);
      expect(headers["x-api-key"]).toBe("sk-test");
      expect(headers["anthropic-version"]).toBeDefined();
      expect(headers.Authorization).toBeUndefined();
    }
  });

  it("routes GLM, Kimi, DeepSeek, and MiMo models to chat/completions with bearer auth", () => {
    const executor = getExecutor("opencode-go");

    for (const model of CHAT_MODELS) {
      const credentials = {
        apiKey: "sk-test",
        runtimeTransport: resolveTransport("opencode-go", "openai", getModelSupportedFormats("opencode-go", model)),
      };
      expect(executor.buildUrl(model, true, 0, credentials)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
      const headers = executor.buildHeaders(credentials, false);
      expect(headers.Authorization).toBe("Bearer sk-test");
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers["anthropic-version"]).toBeUndefined();
    }
  });
});
