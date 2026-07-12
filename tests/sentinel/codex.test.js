import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { request, upstreamChunks } from "./fixtures/codex.js";
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

describe("Codex wire compatibility", () => {
  it("request -> openai upstream body", () => {
    const out = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "gpt-5-codex",
      request,
      true,
      { apiKey: "sk-x" },
      "openai"
    );

    // Structural guards run BEFORE assertGolden: under UPDATE_GOLDEN=1 a regen
    // must not persist a golden for a payload that violates these invariants.
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages.some(message =>
      message.role === "system" && message.content === request.instructions
    )).toBe(true);
    expect(out.messages.some(message =>
      Array.isArray(message.content) && message.content.some(part => part.type === "image_url")
    )).toBe(true);
    expect(out.messages.some(message =>
      message.role === "assistant" && Array.isArray(message.tool_calls)
    )).toBe(true);
    expect(out.messages.some(message => message.role === "tool")).toBe(true);
    assertGolden("codex.request", out);
  });

  it("response -> responses SSE", () => {
    const events = runResponseStream(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      upstreamChunks
    );
    const eventTypes = events.map(event => event.data?.type ?? eventObject(event)?.type);

    // Structural guards run BEFORE assertGolden: under UPDATE_GOLDEN=1 a regen
    // must not persist a golden for a payload that violates these invariants.
    expect(eventTypes).toContain("response.created");
    expect(eventTypes.filter(type => type === "response.output_text.delta").length).toBeGreaterThanOrEqual(1);
    expect(eventTypes).toContain("response.completed");
    assertGolden("codex.response", events);
  });
});
