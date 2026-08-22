import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILES } from "../../open-sse/identity/catalog.js";

const nativeFetch = globalThis.fetch;

async function loadProxyFetch(nodeFetch = vi.fn()) {
  globalThis.fetch = nodeFetch;
  vi.resetModules();
  const mod = await import("../../open-sse/utils/proxyFetch.js");
  mod.__setTransportLoadersForTests({ nodeFetch });
  return mod;
}

describe("identity TLS transport dispatch", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { globalThis.fetch = nativeFetch; });

  it("catalog splits Claude, Chrome, Cursor, and Node transports", () => {
    expect(PROFILES["claude-cli"]).toMatchObject({ tls: "claude-code", alpn: ["http/1.1"] });
    expect(PROFILES["codex-cli"].tls).toBe("chrome");
    expect(PROFILES.chrome.tls).toBe("chrome");
    expect(PROFILES.cursor).toMatchObject({ tls: "node", alpn: ["h2", "http/1.1"] });
    expect(PROFILES["gemini-cli"].tls).toBe("node");
    expect(PROFILES["openai-node"].tls).toBe("node");
    expect(PROFILES.cline.tls).toBe("node");
  });

  it("dispatches Claude without calling Node or Chrome and preserves h1 order", async () => {
    const nodeFetch = vi.fn();
    const chromeFetch = vi.fn();
    const claudeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const { proxyAwareFetch, __setTransportLoadersForTests } = await loadProxyFetch(nodeFetch);
    __setTransportLoadersForTests({ loadChromeFetch: async () => chromeFetch, loadClaudeCodeFetch: async () => claudeFetch });

    await proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      identity: "claude-cli",
      headers: { "content-type": "application/json", authorization: "Bearer caller", "x-client-request-id": "request-id" },
      body: "{}",
    });

    expect(nodeFetch).not.toHaveBeenCalled();
    expect(chromeFetch).not.toHaveBeenCalled();
    const [, init, transport] = claudeFetch.mock.calls[0];
    expect(transport).toMatchObject({ alpn: ["http/1.1"], profileId: "claude-cli", proxyUrl: null });
    expect(Object.keys(init.headers).indexOf("authorization")).toBeLessThan(Object.keys(init.headers).indexOf("content-type"));
  });

  it("uses the count_tokens order without Stainless timeout", async () => {
    const claudeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const { proxyAwareFetch, __setTransportLoadersForTests } = await loadProxyFetch();
    __setTransportLoadersForTests({ loadClaudeCodeFetch: async () => claudeFetch });

    await proxyAwareFetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST", identity: "claude-cli", headers: { Authorization: "Bearer caller", "Content-Type": "application/json" }, body: "{}",
    });

    const [, init, transport] = claudeFetch.mock.calls[0];
    expect(transport.headerOrder).not.toContain("X-Stainless-Timeout");
    expect(Object.keys(init.headers)).not.toContain("X-Stainless-Timeout");
  });

  it("passes no internal identity options to Chrome", async () => {
    const nodeFetch = vi.fn();
    const chromeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const { proxyAwareFetch, __setTransportLoadersForTests } = await loadProxyFetch(nodeFetch);
    __setTransportLoadersForTests({ loadChromeFetch: async () => chromeFetch });

    await proxyAwareFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST", identity: "codex-cli", provider: "codex", format: "openai-responses",
      overlay: { "User-Agent": "codex_cli_rs/0.149.0" }, stream: true, retryCount: 2,
      snapshot: { version: "0.149.0" }, headers: { Authorization: "Bearer caller" }, body: "{}",
    });

    expect(nodeFetch).not.toHaveBeenCalled();
    const [, init] = chromeFetch.mock.calls[0];
    for (const key of ["identity", "provider", "format", "overlay", "stream", "retryCount", "snapshot", "_identityTls", "_identityProfile"]) {
      expect(init).not.toHaveProperty(key);
    }
  });

  it("fails closed with 503 when an impersonator is unavailable", async () => {
    const nodeFetch = vi.fn();
    const { proxyAwareFetch, __setTransportLoadersForTests } = await loadProxyFetch(nodeFetch);
    __setTransportLoadersForTests({
      loadChromeFetch: async () => { throw new Error("impit missing"); },
      loadClaudeCodeFetch: async () => { throw new Error("native helper missing"); },
    });

    await expect(proxyAwareFetch("https://chatgpt.com/backend-api/codex/responses", { identity: "codex-cli" })).rejects.toMatchObject({ status: 503 });
    await expect(proxyAwareFetch("https://api.anthropic.com/v1/messages", { identity: "claude-cli" })).rejects.toMatchObject({ status: 503 });
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it("passes configured proxies to impersonators without Node fallback", async () => {
    const nodeFetch = vi.fn();
    const chromeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const claudeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const { proxyAwareFetch, __setTransportLoadersForTests } = await loadProxyFetch(nodeFetch);
    __setTransportLoadersForTests({ loadChromeFetch: async () => chromeFetch, loadClaudeCodeFetch: async () => claudeFetch });
    const proxy = { enabled: true, url: "http://127.0.0.1:8080" };

    await proxyAwareFetch("https://chatgpt.com/backend-api/codex/responses", { identity: "codex-cli" }, proxy);
    await proxyAwareFetch("https://api.anthropic.com/v1/messages", { identity: "claude-cli" }, proxy);

    expect(chromeFetch.mock.calls[0][2].proxyUrl).toBe("http://127.0.0.1:8080");
    expect(claudeFetch.mock.calls[0][2].proxyUrl).toBe("http://127.0.0.1:8080");
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it("constructs Chrome transport with automatic redirects disabled", async () => {
    const constructorOptions = [];
    class FakeImpit {
      constructor(options) { constructorOptions.push(options); }
      fetch() { return Promise.resolve(new Response("redirect", { status: 302 })); }
    }
    const { proxyAwareFetch, __setTransportLoadersForTests } = await loadProxyFetch();
    __setTransportLoadersForTests({ loadImpit: async () => FakeImpit });

    const response = await proxyAwareFetch("https://chatgpt.com/backend-api/codex/responses", { identity: "codex-cli" }, {
      enabled: true, url: "http://127.0.0.1:8080",
    });

    expect(constructorOptions).toEqual([{
      browser: "chrome",
      proxyUrl: "http://127.0.0.1:8080",
      followRedirects: false,
    }]);
    expect(response.status).toBe(302);
  });
  it("fails closed when Claude snapshot and native TLS capture revisions differ", async () => {
    const nodeFetch = vi.fn();
    const claudeFetch = vi.fn();
    const { proxyAwareFetch, __setTransportLoadersForTests } = await loadProxyFetch(nodeFetch);
    __setTransportLoadersForTests({ loadClaudeCodeFetch: async () => claudeFetch });

    await expect(proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      identity: "claude-cli",
      snapshot: {
        version: "2.1.239",
        billingVersion: "2.1.239",
        tlsSpecRev: "2.1.239",
        userAgent: "claude-cli/2.1.239 (external, cli)",
        packageVersion: "0.94.0",
        runtimeVersion: "v22.19.0",
        betas: "oauth-2025-04-20",
      },
    })).rejects.toMatchObject({ status: 503 });
    expect(claudeFetch).not.toHaveBeenCalled();
    expect(nodeFetch).not.toHaveBeenCalled();
  });


  it("keeps relay-only headers on the relay hop", async () => {
    const nodeFetch = vi.fn().mockResolvedValue(new Response("relay"));
    const claudeFetch = vi.fn();
    const { proxyAwareFetch, __setTransportLoadersForTests } = await loadProxyFetch(nodeFetch);
    __setTransportLoadersForTests({ loadClaudeCodeFetch: async () => claudeFetch });

    await proxyAwareFetch("https://api.anthropic.com/v1/messages", { identity: "claude-cli", headers: { Authorization: "Bearer caller" } }, {
      vercelRelayUrl: "https://relay.example/fetch",
    });

    expect(claudeFetch).not.toHaveBeenCalled();
    expect(nodeFetch).toHaveBeenCalledWith("https://relay.example/fetch", expect.objectContaining({ headers: expect.objectContaining({
      "x-relay-target": "https://api.anthropic.com", "x-relay-path": "/v1/messages",
    }) }));
  });
});
