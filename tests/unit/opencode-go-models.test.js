import { describe, expect, it } from "vitest";
import {
  PROVIDER_MODELS,
  getModelSupportedFormats,
  getModelTargetFormat,
} from "../../open-sse/config/providerModels.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

const CHAT_MODELS = [
  "glm-5.2",
  "glm-5.1",
  // OpenCode Go docs' endpoint table currently says kimi-k2.7, but its
  // config example and the live API use kimi-k2.7-code.
  "kimi-k2.7-code",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
];

const MESSAGES_MODELS = [
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
];

const MULTI_TRANSPORT_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];

describe("OpenCode Go official model catalog", () => {
  it("matches the documented OpenCode Go model IDs", () => {
    const ids = (PROVIDER_MODELS["opencode-go"] || []).map((model) => model.id);

    expect(ids).toEqual([...CHAT_MODELS, ...MESSAGES_MODELS]);
  });

  it("marks documented Qwen and MiniMax models as Anthropic messages format", () => {
    for (const model of MESSAGES_MODELS) {
      expect(getModelTargetFormat("opencode-go", model)).toBe("claude");
    }
  });

  it("keeps GLM, Kimi, DeepSeek, and MiMo on OpenAI-compatible chat format", () => {
    for (const model of CHAT_MODELS) {
      expect(getModelTargetFormat("opencode-go", model)).toBeNull();
    }
  });

  it("declares the native transports supported by each model", () => {
    for (const model of CHAT_MODELS.filter((id) => !MULTI_TRANSPORT_MODELS.includes(id))) {
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
