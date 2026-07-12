import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { request, upstreamChunks } from "./fixtures/claude-code.js";
import { assertGolden, runResponseStream } from "./helpers.js";

function eventObject(event) {
  if (event && typeof event === "object") return event;
  if (typeof event !== "string") return null;

  const data = event.startsWith("data: ") ? event.slice(6) : event;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

describe("Claude Code wire compatibility", () => {
  it("translates a Claude Code messages request to OpenAI", () => {
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "gpt-4o",
      request,
      true,
      { apiKey: "sk-x" },
      "openai"
    );

    assertGolden("claude-code.request", out);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages.some(message =>
      message.role === "tool" ||
      (message.role === "assistant" && Array.isArray(message.tool_calls))
    )).toBe(true);
  });

  it("translates OpenAI chunks to Claude message events", () => {
    const events = runResponseStream(FORMATS.OPENAI, FORMATS.CLAUDE, upstreamChunks);
    const parsedEvents = events.map(eventObject).filter(Boolean);
    const eventTypes = parsedEvents.map(event => event.type);

    assertGolden("claude-code.response", events);
    expect(eventTypes).toContain("message_start");
    expect(eventTypes.filter(type => type === "content_block_delta").length).toBeGreaterThanOrEqual(1);
    expect(parsedEvents.some(event => event.type === "message_delta" && event.usage)).toBe(true);
    expect(eventTypes).toContain("message_stop");
  });
});
