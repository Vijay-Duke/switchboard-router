import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("OpenCode Free Union Alpha", () => {
  it("routes Union Alpha through Anthropic Messages", () => {
    const caps = getCapabilitiesForModel("opencode", "union-alpha");
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(262144);
    expect(caps.maxOutput).toBe(131072);

    expect(getModelTargetFormat("oc", "union-alpha")).toBe(FORMATS.CLAUDE);

    const executor = new OpenCodeExecutor();
    const url = executor.buildUrl("union-alpha");
    // v2 client fingerprint routes the free lane through /inference/v1.
    expect(url).toBe("https://opencode.ai/inference/v1/messages");
    expect(executor.buildUrl("union-alpha(high)")).toBe("https://opencode.ai/inference/v1/messages");
    expect(executor.buildHeaders({}, true, url)).toMatchObject({ "anthropic-version": "2023-06-01" });
  });

  it("leaves the other free models on Chat Completions", () => {
    const executor = new OpenCodeExecutor();
    const url = executor.buildUrl("big-pickle");
    expect(url).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(executor.buildHeaders({}, true, url)).not.toHaveProperty("anthropic-version");
    expect(getModelTargetFormat("oc", "big-pickle")).toBeNull();
  });
});
