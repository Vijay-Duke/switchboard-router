import { describe, expect, it } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getTargetFormat, resolveOpenAICompatibleApiType } from "../../open-sse/services/provider.js";

// Imported model IDs stay provider-scoped; the bug was choosing transport
// from the legacy provider suffix instead of the saved apiType on the node.
const BASE_CREDENTIALS = {
  apiKey: "test-key",
  providerSpecificData: {
    baseUrl: "https://crof.example/v1",
  },
};

function buildUrl(executor, provider, credentials) {
  return executor.buildUrl("test-model", false, 0, credentials);
}

describe("OpenAI-compatible apiType routing", () => {
  it("prefers saved chat over a legacy responses provider id", () => {
    const credentials = {
      ...BASE_CREDENTIALS,
      providerSpecificData: {
        ...BASE_CREDENTIALS.providerSpecificData,
        apiType: "chat",
      },
    };
    const defaultExecutor = new DefaultExecutor("openai-compatible-responses-crof");
    const baseExecutor = new BaseExecutor("openai-compatible-responses-crof", {});

    expect(resolveOpenAICompatibleApiType("openai-compatible-responses-crof", credentials)).toBe("chat");
    expect(getTargetFormat("openai-compatible-responses-crof", credentials)).toBe("openai");
    expect(buildUrl(defaultExecutor, "openai-compatible-responses-crof", credentials)).toBe("https://crof.example/v1/chat/completions");
    expect(buildUrl(baseExecutor, "openai-compatible-responses-crof", credentials)).toBe("https://crof.example/v1/chat/completions");
  });

  it("prefers saved responses over a legacy chat provider id", () => {
    const credentials = {
      ...BASE_CREDENTIALS,
      providerSpecificData: {
        ...BASE_CREDENTIALS.providerSpecificData,
        apiType: "responses",
      },
    };
    const defaultExecutor = new DefaultExecutor("openai-compatible-chat-crof");
    const baseExecutor = new BaseExecutor("openai-compatible-chat-crof", {});

    expect(resolveOpenAICompatibleApiType("openai-compatible-chat-crof", credentials)).toBe("responses");
    expect(getTargetFormat("openai-compatible-chat-crof", credentials)).toBe("openai-responses");
    expect(buildUrl(defaultExecutor, "openai-compatible-chat-crof", credentials)).toBe("https://crof.example/v1/responses");
    expect(buildUrl(baseExecutor, "openai-compatible-chat-crof", credentials)).toBe("https://crof.example/v1/responses");
  });

  it("falls back to the legacy suffix when the saved apiType is invalid", () => {
    const credentials = {
      ...BASE_CREDENTIALS,
      providerSpecificData: {
        ...BASE_CREDENTIALS.providerSpecificData,
        apiType: "invalid",
      },
    };
    const defaultExecutor = new DefaultExecutor("openai-compatible-responses-crof");
    const baseExecutor = new BaseExecutor("openai-compatible-responses-crof", {});

    expect(resolveOpenAICompatibleApiType("openai-compatible-responses-crof", credentials)).toBe("responses");
    expect(getTargetFormat("openai-compatible-responses-crof", credentials)).toBe("openai-responses");
    expect(buildUrl(defaultExecutor, "openai-compatible-responses-crof", credentials)).toBe("https://crof.example/v1/responses");
    expect(buildUrl(baseExecutor, "openai-compatible-responses-crof", credentials)).toBe("https://crof.example/v1/responses");
  });

  it("keeps the legacy fallback when no saved apiType exists", () => {
    const credentials = {
      ...BASE_CREDENTIALS,
      providerSpecificData: {
        ...BASE_CREDENTIALS.providerSpecificData,
      },
    };
    const defaultExecutor = new DefaultExecutor("openai-compatible-responses-crof");
    const baseExecutor = new BaseExecutor("openai-compatible-responses-crof", {});

    expect(resolveOpenAICompatibleApiType("openai-compatible-responses-crof", credentials)).toBe("responses");
    expect(getTargetFormat("openai-compatible-responses-crof", credentials)).toBe("openai-responses");
    expect(buildUrl(defaultExecutor, "openai-compatible-responses-crof", credentials)).toBe("https://crof.example/v1/responses");
    expect(buildUrl(baseExecutor, "openai-compatible-responses-crof", credentials)).toBe("https://crof.example/v1/responses");
  });
});
