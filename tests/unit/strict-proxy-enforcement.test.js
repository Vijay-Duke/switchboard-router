// Upstream #4333: "Strict Proxy" did not hold when no proxy URL resolved —
// proxyAwareFetch only honoured strictProxy inside the catch of a proxy
// attempt, so with nothing to try it connected directly. Switchboard has no
// proxy pools, so only the per-connection proxy half applies here.
import { describe, expect, it, vi } from "vitest";

// Capture direct egress: proxyFetch binds the pre-patch global fetch at import.
const direct = vi.fn(async () => new Response("direct", { status: 200 }));
globalThis.fetch = direct;
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const URL_ = "https://api.example.com/v1/chat";

describe("strictProxy refuses a direct connection (#4333)", () => {
  it("throws when the connection proxy is enabled but carries an empty url", async () => {
    direct.mockClear();
    await expect(
      proxyAwareFetch(URL_, {}, { connectionProxyEnabled: true, connectionProxyUrl: "", strictProxy: true }),
    ).rejects.toThrow(/strictProxy/);
    expect(direct).not.toHaveBeenCalled();
  });

  it("throws for the enabled/url option shape too", async () => {
    await expect(
      proxyAwareFetch(URL_, {}, { enabled: true, url: "  ", strictProxy: true }),
    ).rejects.toThrow(/strictProxy/);
  });

  it("does not block a caller that sets strictProxy with no proxy configured", async () => {
    // e.g. "don't replay directly if the proxy fails" callers with no proxy.
    direct.mockClear();
    const res = await proxyAwareFetch(URL_, {}, { strictProxy: true });
    expect(await res.text()).toBe("direct");
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("lets an explicit no_proxy bypass stay direct under strict mode", async () => {
    direct.mockClear();
    const res = await proxyAwareFetch(URL_, {}, {
      connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890",
      connectionNoProxy: "api.example.com", strictProxy: true,
    });
    expect(await res.text()).toBe("direct");
  });

  it("does not block a request when strictProxy is off", async () => {
    direct.mockClear();
    const res = await proxyAwareFetch(URL_, {}, { connectionProxyEnabled: true, connectionProxyUrl: "", strictProxy: false });
    expect(await res.text()).toBe("direct");
  });
});
