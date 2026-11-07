import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom, formatHeadroomLog } from "../../open-sse/rtk/headroom.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compressWithHeadroom", () => {
  it("no-ops when disabled", async () => {
    global.fetch = vi.fn();
    const body = { messages: [{ role: "user", content: "hello" }] };

    const stats = await compressWithHeadroom(body, { enabled: false, url: "http://localhost:8787" });

    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(body.messages[0].content).toBe("hello");
  });

  it("compresses messages in-place", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ role: "user", content: "short" }],
      tokens_before: 100,
      tokens_after: 20,
      tokens_saved: 80,
    }), { status: 200 }));
    const body = { messages: [{ role: "user", content: "long" }] };

    const stats = await compressWithHeadroom(body, { enabled: true, url: "http://headroom:8787/", model: "gpt-4o" });

    expect(body.messages[0].content).toBe("short");
    expect(stats.tokens_saved).toBe(80);
    expect(global.fetch).toHaveBeenCalledWith("http://headroom:8787/v1/compress", expect.objectContaining({ method: "POST" }));
  });

  it("compresses responses input in-place", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ role: "user", content: "short" }],
    }), { status: 200 }));
    const body = { input: [{ role: "user", content: "long" }] };

    await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787" });

    expect(body.input[0].content).toBe("short");
  });

  it("fails open on bad response", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "bad" }), { status: 500 }));
    const body = { messages: [{ role: "user", content: "long" }] };

    const stats = await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787" });

    expect(stats).toBeNull();
    expect(body.messages[0].content).toBe("long");
  });

  it("skips unknown shapes", async () => {
    global.fetch = vi.fn();
    const body = { contents: [{ parts: [{ text: "long" }] }] };

    const stats = await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787" });

    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe("timeout normalization", () => {
    const mockResponse = JSON.stringify({
      messages: [{ role: "user", content: "short" }],
      tokens_before: 100,
      tokens_after: 20,
      tokens_saved: 80,
    });

    function makeSuccessfulFetch() {
      global.fetch = vi.fn(async () =>
        new Response(mockResponse, { status: 200 })
      );
    }

    function captureTimeoutCalls() {
      const calls = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        calls.push(ms);
        const controller = new AbortController();
        return controller.signal;
      });
      return calls;
    }

    it("passes a valid positive timeout to AbortSignal.timeout", async () => {
      makeSuccessfulFetch();
      const calls = captureTimeoutCalls();
      const body = { messages: [{ role: "user", content: "hello" }] };

      await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", timeoutMs: 5000 });

      expect(calls).toContain(5000);
    });

    it("falls back to the default timeout when timeoutMs is null", async () => {
      makeSuccessfulFetch();
      const calls = captureTimeoutCalls();
      const body = { messages: [{ role: "user", content: "hello" }] };

      await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", timeoutMs: null });

      expect(calls).toContain(3000);
    });

    it("falls back to the default timeout when timeoutMs is 0", async () => {
      makeSuccessfulFetch();
      const calls = captureTimeoutCalls();
      const body = { messages: [{ role: "user", content: "hello" }] };

      await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", timeoutMs: 0 });

      expect(calls).toContain(3000);
    });

    it("falls back to the default timeout when timeoutMs is negative", async () => {
      makeSuccessfulFetch();
      const calls = captureTimeoutCalls();
      const body = { messages: [{ role: "user", content: "hello" }] };

      await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", timeoutMs: -100 });

      expect(calls).toContain(3000);
    });

    it("falls back to the default timeout when timeoutMs is NaN", async () => {
      makeSuccessfulFetch();
      const calls = captureTimeoutCalls();
      const body = { messages: [{ role: "user", content: "hello" }] };

      await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", timeoutMs: NaN });

      expect(calls).toContain(3000);
    });

    it("falls back to the default timeout when timeoutMs is Infinity", async () => {
      makeSuccessfulFetch();
      const calls = captureTimeoutCalls();
      const body = { messages: [{ role: "user", content: "hello" }] };

      await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", timeoutMs: Infinity });

      expect(calls).toContain(3000);
    });

    it("falls back to the default timeout when timeoutMs is a string", async () => {
      makeSuccessfulFetch();
      const calls = captureTimeoutCalls();
      const body = { messages: [{ role: "user", content: "hello" }] };

      await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", timeoutMs: "5000" });

      expect(calls).toContain(3000);
    });
  });
});

describe("formatHeadroomLog", () => {
  it("formats reported token deltas without implying provider billing savings", () => {
    expect(formatHeadroomLog({ tokens_before: 100, tokens_after: 25, tokens_saved: 75 }))
      .toBe("reported token delta=75 before=100 after=25 (75.0%)");
  });
});
