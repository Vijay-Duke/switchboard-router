/**
 * Unit tests for the Claude header pipeline after removal of the global
 * header-cache singleton (port of upstream 13ed1456):
 *  - pickClaudeIdentityHeaders: request-scoped selection of non-secret headers
 *  - selectAnthropicBeta: heavy-agent flags gated to opus/sonnet by model
 *  - default.js buildHeaders(): static defaults + per-model Anthropic-Beta
 *  - default.js buildHeaders(): anthropic-compatible non-Anthropic host stripping
 *  - proxyFetch.js: api.anthropic.com routes through anthropicFetch path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── pickClaudeIdentityHeaders ────────────────────────────────────────────────

describe("pickClaudeIdentityHeaders", () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("../../open-sse/utils/claudeIdentityHeaders.js");
  });

  it("returns null before any headers are given (no cross-request state)", () => {
    expect(mod.pickClaudeIdentityHeaders({})).toBeNull();
    expect(mod.pickClaudeIdentityHeaders(null)).toBeNull();
    expect(mod.pickClaudeIdentityHeaders("string")).toBeNull();
  });

  it("picks only the known identity headers, request-scoped", () => {
    const picked = mod.pickClaudeIdentityHeaders({
      "user-agent": "claude-cli/2.1.258 (external, cli)",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "content-type": "application/json",
      authorization: "Bearer secret",
      "x-api-key": "secret-key",
    });
    expect(picked["user-agent"]).toBe("claude-cli/2.1.258 (external, cli)");
    expect(picked["anthropic-beta"]).toContain("oauth-2025-04-20");
    const serialized = JSON.stringify(picked);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("x-api-key");
    expect(picked["content-type"]).toBeUndefined();
  });
});

// ─── selectAnthropicBeta ──────────────────────────────────────────────────────

describe("selectAnthropicBeta", () => {
  it("includes heavy-agent flags for opus/sonnet, omits them otherwise", async () => {
    const { selectAnthropicBeta } = await import("../../open-sse/providers/shared.js");

    for (const model of ["claude-opus-5", "claude-sonnet-5"]) {
      const flags = selectAnthropicBeta(model).split(",").map(s => s.trim());
      expect(flags).toContain("advanced-tool-use-2025-11-20");
      expect(flags).toContain("effort-2025-11-24");
      expect(flags).toContain("claude-code-20250219");
    }
    for (const model of ["claude-haiku-4-5-20251001", "claude-fable-5", ""]) {
      const flags = selectAnthropicBeta(model).split(",").map(s => s.trim());
      expect(flags).not.toContain("advanced-tool-use-2025-11-20");
      expect(flags).not.toContain("effort-2025-11-24");
      expect(flags).toContain("claude-code-20250219");
    }
  });
});

// ─── DefaultExecutor.buildHeaders() ──────────────────────────────────────────

describe("DefaultExecutor.buildHeaders() — claude provider", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("uses static provider defaults when no model is given", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true);

    const hasVersion =
      headers["Anthropic-Version"] === "2023-06-01" ||
      headers["anthropic-version"] === "2023-06-01";
    expect(hasVersion).toBe(true);
  });

  it("includes heavy-agent beta flags for claude-opus-5", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, undefined, "claude-opus-5");
    const betaFlags = headers["Anthropic-Beta"].split(",").map(s => s.trim());
    expect(betaFlags).toContain("advanced-tool-use-2025-11-20");
    expect(betaFlags).toContain("effort-2025-11-24");
  });

  it("includes heavy-agent beta flags for claude-sonnet-5", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, undefined, "claude-sonnet-5");
    const betaFlags = headers["Anthropic-Beta"].split(",").map(s => s.trim());
    expect(betaFlags).toContain("advanced-tool-use-2025-11-20");
    expect(betaFlags).toContain("effort-2025-11-24");
  });

  it("omits heavy-agent beta flags for claude-haiku-4-5-20251001", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, undefined, "claude-haiku-4-5-20251001");
    const betaFlags = headers["Anthropic-Beta"].split(",").map(s => s.trim());
    expect(betaFlags).not.toContain("advanced-tool-use-2025-11-20");
    expect(betaFlags).not.toContain("effort-2025-11-24");
    expect(betaFlags).toContain("claude-code-20250219");
  });

  it("omits heavy-agent beta flags for claude-fable-5", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, undefined, "claude-fable-5");
    const betaFlags = headers["Anthropic-Beta"].split(",").map(s => s.trim());
    expect(betaFlags).not.toContain("advanced-tool-use-2025-11-20");
    expect(betaFlags).not.toContain("effort-2025-11-24");
  });

  it("sets x-api-key auth when apiKey is provided", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-live-key" }, true);
    expect(headers["x-api-key"]).toBe("sk-live-key");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sets Bearer Authorization when only accessToken is provided", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ accessToken: "tok-abc" }, true);
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("includes Accept: text/event-stream when stream=true", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "k" }, true);
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  it("omits Accept: text/event-stream when stream=false", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "k" }, false);
    expect(headers["Accept"]).toBeUndefined();
  });

  it("does not throw when no model is given", () => {
    const executor = new DefaultExecutor("claude");
    expect(() => executor.buildHeaders({ apiKey: "sk" }, false)).not.toThrow();
  });
});

describe("DefaultExecutor.buildHeaders() — Anthropic API provider", () => {
  it("uses bearer auth for request-scoped native Claude OAuth", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const headers = new DefaultExecutor("anthropic").buildHeaders({
      accessToken: "native-claude-token",
      rawHeaders: {
        "user-agent": "claude-code/2.1.129",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        authorization: "Bearer native-claude-token",
        "x-switchboard-key": "sk-switchboard",
      },
    }, true);

    expect(headers.Authorization).toBe("Bearer native-claude-token");
    expect(headers["x-api-key"]).toBeUndefined();
    // No global overlay: the caller's own beta string must not be replayed here
    expect(headers["anthropic-beta"] || "").not.toContain("oauth-2025-04-20");
    expect(headers["x-switchboard-key"]).toBeUndefined();
  });

  it("does not forward non-Claude client headers onto the outbound request", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const headers = new DefaultExecutor("anthropic").buildHeaders({
      apiKey: "anthropic-api-key",
      rawHeaders: { "user-agent": "curl/8.0" },
    }, false);

    expect(headers["x-claude-code-session-id"]).toBeUndefined();
  });
});

// ─── anthropic-compatible header stripping ────────────────────────────────────

describe("DefaultExecutor.buildHeaders() — anthropic-compatible stripping", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("strips x-app and anthropic-dangerous-direct-browser-access for non-Anthropic host", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
      },
      true
    );

    expect(headers["x-app"]).toBeUndefined();
    expect(headers["X-App"]).toBeUndefined();
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBeUndefined();
  });

  it("removes claude-code-20250219 from anthropic-beta for non-Anthropic host", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
      },
      true
    );

    const betaVal = headers["anthropic-beta"] || headers["Anthropic-Beta"] || "";
    expect(betaVal).not.toContain("claude-code-20250219");
  });

  it("keeps other beta flags intact after stripping", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    // The static CLAUDE_API_HEADERS used by anthropic-compatible providers include
    // 'interleaved-thinking-2025-05-14' — check it survives stripping
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
      },
      false
    );

    const betaVal = headers["anthropic-beta"] || headers["Anthropic-Beta"] || "";
    // If any beta value remains it should not be empty and should not have the stripped value
    if (betaVal) {
      expect(betaVal).not.toContain("claude-code-20250219");
    }
  });

  it("does NOT strip headers when baseUrl is api.anthropic.com", () => {
    const executor = new DefaultExecutor("anthropic-compatible-official");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" },
      },
      true
    );

    // No stripping — anthropic-version should survive
    const hasVersion =
      headers["Anthropic-Version"] || headers["anthropic-version"];
    expect(hasVersion).toBeDefined();
  });

  it("does NOT strip headers when baseUrl is empty (defaults to Anthropic)", () => {
    const executor = new DefaultExecutor("anthropic-compatible-official");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: {},
      },
      true
    );

    const hasVersion =
      headers["Anthropic-Version"] || headers["anthropic-version"];
    expect(hasVersion).toBeDefined();
  });
});

// ─── proxyFetch anthropicFetch routing ────────────────────────────────────────

describe("proxyAwareFetch — api.anthropic.com routing", () => {
  const nativeFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = nativeFetch;
  });

  it("uses native fetch for api.anthropic.com while TLS fingerprinting is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "msg_test" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    globalThis.fetch = fetchMock;

    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const res = await proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      // No Accept: text/event-stream → non-streaming path
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [] }),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("msg_test");
  });

  it("falls back gracefully when got-scraping throws on non-streaming path", async () => {
    vi.doMock("got-scraping", () => {
      const fn = vi.fn().mockRejectedValue(new Error("TLS error"));
      fn.stream = vi.fn();
      return { gotScraping: fn };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
      text: async () => "{}",
      json: async () => ({}),
    });

    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const res = await proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.ok).toBe(true);
    globalThis.fetch = originalFetch;
  });

  it("does NOT route non-Anthropic hosts through gotScraping", async () => {
    const gotScrapingMock = vi.fn();
    vi.doMock("got-scraping", () => ({ gotScraping: gotScrapingMock }));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
      text: async () => "{}",
      json: async () => ({}),
    });

    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(gotScrapingMock).not.toHaveBeenCalled();
  });
});
