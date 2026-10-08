import { describe, expect, it, vi } from "vitest";
import { createEmptyRetryStream } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";
const empty = () => new ReadableStream({ start(controller) { controller.close(); } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe("empty-stream cancellation during retries", () => {
  it("preserves a delivered tool call without replay after the upstream disconnects", async () => {
    const reexecute = vi.fn(), onExhausted = vi.fn();
    const wire = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "write_file", args: { path: "file.txt" } } }] } }] })}\n\n`;
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (sent) controller.error(new Error("socket closed after tool output"));
        else { sent = true; controller.enqueue(new TextEncoder().encode(wire)); }
      },
    }, { highWaterMark: 0 });
    const output = createEmptyRetryStream({ body, reexecute, onExhausted, baseDelayMs: 0, stallTimeoutMs: 0 });
    expect(await new Response(output).text()).toBe(wire);
    expect(reexecute).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });
  it("does not bench an account when the consumer cancels the final attempt", async () => {
    const onExhausted = vi.fn();
    let finalStarted, finalBody;
    const started = new Promise(resolve => { finalStarted = resolve; });
    const reexecute = vi.fn().mockResolvedValueOnce(empty()).mockImplementationOnce(async () => {
      finalStarted();
      finalBody = new ReadableStream();
      return finalBody;
    });
    const output = createEmptyRetryStream({ body: empty(), reexecute, onExhausted, baseDelayMs: 0, stallTimeoutMs: 0 });
    const reader = output.getReader();
    await started;
    await vi.waitFor(() => expect(finalBody.locked).toBe(true));
    await reader.cancel("client disconnected");
    await tick();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(reexecute).toHaveBeenCalledTimes(2);
  });
  it("cancels a retried response arriving after the consumer disconnected", async () => {
    let resolveRetry, retryEntered;
    const entered = new Promise(resolve => { retryEntered = resolve; });
    const reexecute = vi.fn(() => new Promise(resolve => { resolveRetry = resolve; retryEntered(); }));
    const output = createEmptyRetryStream({ body: empty(), reexecute, baseDelayMs: 0, stallTimeoutMs: 0 });
    const reader = output.getReader();
    await entered;
    await reader.cancel("client disconnected");
    const cancelNext = vi.fn();
    resolveRetry(new ReadableStream({ cancel: cancelNext }));
    await tick();
    expect(cancelNext).toHaveBeenCalledTimes(1);
  });
});
