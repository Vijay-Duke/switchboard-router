import { describe, expect, it } from "vitest";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const HEADER = "x-anthropic-billing-header: cc_version=2.1.275.f15; cc_entrypoint=cli;";

function systemTextSentToAntigravity(systemContent) {
  // OpenAI-format client (e.g. a proxy converting Claude Code to /v1/chat/completions).
  const body = openaiToAntigravityRequest("gemini-3.8-flash-tiered", {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "hi" },
    ],
  }, true);
  const finalBody = new AntigravityExecutor().transformRequest("gemini-3.8-flash-tiered", body, true, {});
  return finalBody.request.systemInstruction.parts.map((p) => p.text).join("\n");
}

describe("Antigravity strips the Claude Code billing header from system prompts", () => {
  it("removes the header line prepended by Claude Code", () => {
    const text = systemTextSentToAntigravity(`${HEADER}\n\nYou are Claude Code, Anthropic's official CLI for Claude.`);
    expect(text).not.toContain("x-anthropic-billing-header");
    expect(text).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it("removes the header when it is not the first line", () => {
    const text = systemTextSentToAntigravity(`Some preamble\n${HEADER}\nRest of prompt`);
    expect(text).not.toContain("x-anthropic-billing-header");
    expect(text).toContain("Some preamble");
    expect(text).toContain("Rest of prompt");
  });

  it("leaves prompts without the header untouched", () => {
    const text = systemTextSentToAntigravity("You are a helpful assistant.");
    expect(text).toContain("You are a helpful assistant.");
  });
});

describe("Antigravity rewrites competing-client branding in system prompts", () => {
  it("drops the Zed Claude Agent SDK line", () => {
    const text = systemTextSentToAntigravity("You are a Claude agent, built on Anthropic's Claude Agent SDK. Help the user.");
    expect(text).not.toContain("Claude Agent SDK");
    expect(text).toContain("Help the user.");
  });

  it("rebrands OpenCode while preserving case", () => {
    const text = systemTextSentToAntigravity("You are OpenCode. Config lives in .opencode, env OPENCODE_HOME.");
    expect(text.split("\n").at(-1)).toBe("You are Antigravity. Config lives in .antigravity, env ANTIGRAVITY_HOME.");
  });

  it.each([
    "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
    "You are Hermes, an AI agent built by Nous Research.",
    "You are Hermes Agent.",
  ])("neutralizes the Hermes identity: %s", (prompt) => {
    expect(systemTextSentToAntigravity(`${prompt} Be concise.`).split("\n").at(-1)).toBe("You are an AI assistant. Be concise.");
  });
});
