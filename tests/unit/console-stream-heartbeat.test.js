import { describe, expect, it, vi, afterEach } from "vitest";
import { GET } from "@/app/api/translator/console-logs/stream/route.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("console-log stream initial frame (W13)", () => {
  it("sends an SSE comment frame first so EventSource onopen fires with no logs", async () => {
    const controller = new AbortController();
    const res = await GET({ signal: controller.signal });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const text = new TextDecoder().decode(first.value);
    expect(text.startsWith(":")).toBe(true);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
