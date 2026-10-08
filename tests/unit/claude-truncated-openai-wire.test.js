import { describe, it, expect, vi } from "vitest";
vi.mock("../../open-sse/runtimeDeps.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../open-sse/utils/usageTracking.js", async (importOriginal) => ({
  ...await importOriginal(), logUsage: vi.fn(),
}));
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
const chunk = (delta, finish_reason = null) => ({
  id: "chatcmpl-truncated-regression", model: "test-model",
  choices: [{ index: 0, delta, finish_reason }],
});
async function wireEvents(chunks) {
  const payload = chunks.map(c => "data: " + JSON.stringify(c) + "\n\n").join("");
  const upstream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); },
  });
  const wire = await new Response(upstream.pipeThrough(createSSETransformStreamWithLogger(
    FORMATS.OPENAI, FORMATS.CLAUDE, "test-provider",
  ))).text();
  return wire.split("\n\n").filter(Boolean).map(frame => {
    const data = frame.split("\n").find(line => line.startsWith("data: "));
    return JSON.parse(data.slice(6));
  });
}
function expectInterrupted(events) {
  expect(events.filter(e => e.type === "error")).toHaveLength(1);
  expect(events.find(e => e.type === "error").error).toMatchObject({ type: "api_error" });
  expect(events.some(e => e.type === "message_stop" || e.type === "message_delta")).toBe(false);
}
describe("OpenAI to Claude reconstructed wire terminal", () => {
  it("surfaces truncated tool arguments as an error without declaring a successful call", async () => {
    const events = await wireEvents([chunk({ tool_calls: [{
      index: 0, id: "call_partial", function: { name: "inspect", arguments: '{"path":' },
    }] })]);
    expect(events.some(e => e.type === "content_block_start" && e.content_block.name === "inspect")).toBe(true);
    expectInterrupted(events);
    expect(events.some(e => e.delta?.type === "input_json_delta" || e.type === "content_block_stop")).toBe(false);
  });
  it("requires a real finish even if buffered tool arguments happen to be valid JSON", async () => {
    const events = await wireEvents([chunk({ tool_calls: [{
      index: 0, id: "call_complete_json", function: { name: "inspect", arguments: "{}" },
    }] })]);
    expectInterrupted(events);
    expect(events.some(e => e.delta?.type === "input_json_delta")).toBe(false);
  });
  it("keeps delivered text but reports that a clean EOF interrupted its turn", async () => {
    const events = await wireEvents([chunk({ content: "Partial answer" })]);
    expect(events.find(e => e.delta?.type === "text_delta").delta.text).toBe("Partial answer");
    expectInterrupted(events);
  });
  it("keeps an explicit tool_calls finish successful with exact ID and complete arguments", async () => {
    const events = await wireEvents([
      chunk({ tool_calls: [{ index: 0, id: "call_valid", function: { name: "inspect", arguments: '{"path":"a"}' } }] }),
      chunk({}, "tool_calls"),
    ]);
    expect(events.filter(e => e.type === "error")).toHaveLength(0);
    expect(events.find(e => e.type === "content_block_start").content_block).toMatchObject({
      type: "tool_use", id: "call_valid", name: "inspect",
    });
    expect(events.find(e => e.delta?.type === "input_json_delta").delta.partial_json).toBe('{"path":"a"}');
    expect(events.find(e => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
    expect(events.filter(e => e.type === "message_stop")).toHaveLength(1);
  });
  it("keeps an explicitly completed text stream successful", async () => {
    const events = await wireEvents([chunk({ content: "Done" }), chunk({}, "stop")]);
    expect(events.filter(e => e.type === "error")).toHaveLength(0);
    expect(events.find(e => e.type === "message_delta").delta.stop_reason).toBe("end_turn");
    expect(events.filter(e => e.type === "message_stop")).toHaveLength(1);
  });
});
