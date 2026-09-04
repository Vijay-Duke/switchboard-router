import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Deterministic DNS for the bypass cache: two A records, one AAAA fallback host.
vi.mock("dns", () => {
  class Resolver {
    setServers() {}
    resolve4(hostname, cb) {
      if (hostname === "v6only.example") return cb(new Error("ENODATA"));
      cb(null, ["10.0.0.1", "10.0.0.2"]);
    }
    resolve6(hostname, cb) {
      if (hostname === "v6only.example") return cb(null, ["2001:db8::1"]);
      cb(null, []);
    }
  }
  return { default: { Resolver }, Resolver };
});

const originalFetch = globalThis.fetch;
const relayFetch = vi.fn(async () => new Response("{}", { status: 200 }));
let proxyFetch;

beforeAll(async () => {
  // proxyFetch captures the global fetch at import time as its "original";
  // stub it first so the relay hop lands in our spy.
  globalThis.fetch = relayFetch;
  vi.resetModules();
  proxyFetch = await import("../../open-sse/utils/proxyFetch.js");
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("proxyOptionsFromCredentials (H27)", () => {
  it("builds the per-connection egress options chatCore used to build inline", () => {
    expect(proxyFetch.proxyOptionsFromCredentials({
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.example:8080",
        connectionNoProxy: "localhost",
        vercelRelayUrl: "https://relay.example/fetch",
        strictProxy: true,
      },
    })).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "localhost",
      vercelRelayUrl: "https://relay.example/fetch",
      strictProxy: true,
    });
  });

  it("degrades to direct egress for credentials without connection settings", () => {
    expect(proxyFetch.proxyOptionsFromCredentials(null)).toEqual({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    });
  });

  it("routes a real proxyAwareFetch through the vercel relay when the helper's options are passed (H28 Headers normalized)", async () => {
    relayFetch.mockClear();
    const options = proxyFetch.proxyOptionsFromCredentials({ providerSpecificData: { vercelRelayUrl: "https://relay.example/fetch" } });

    await proxyFetch.proxyAwareFetch("https://api.upstream.test/v1/embeddings?x=1", {
      method: "POST",
      headers: new Headers({ Authorization: "Bearer secret", "Content-Type": "application/json" }),
      body: "{}",
      identity: "openai-node",
    }, options);

    expect(relayFetch).toHaveBeenCalledTimes(1);
    const [url, init] = relayFetch.mock.calls[0];
    expect(url).toBe("https://relay.example/fetch");
    expect(init.headers["x-relay-target"]).toBe("https://api.upstream.test");
    expect(init.headers["x-relay-path"]).toBe("/v1/embeddings?x=1");
    const lower = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower.authorization).toBe("Bearer secret");
    expect(JSON.stringify(init.headers)).not.toMatch(/switchboard/i);
  });
});

describe("DNS bypass cache (H29)", () => {
  it("caches the full address list and rotates per request", async () => {
    const first = await proxyFetch.resolveRealIP("multi.example");
    const second = await proxyFetch.resolveRealIP("multi.example");
    const third = await proxyFetch.resolveRealIP("multi.example");
    expect(first).toBe("10.0.0.1");
    expect(second).toBe("10.0.0.2");
    expect(third).toBe("10.0.0.1");
  });

  it("falls back to AAAA when there is no A record", async () => {
    expect(await proxyFetch.resolveRealIP("v6only.example")).toBe("2001:db8::1");
  });
});
