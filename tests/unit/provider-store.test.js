import { afterEach, describe, expect, it, vi } from "vitest";
import useProviderStore from "@/store/providerStore";

afterEach(() => {
  useProviderStore.setState({ providers: [], loading: false, error: null, lastFetched: 0 });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("providerStore fetchProviders dedup (D15)", () => {
  it("shares one fetch across concurrent calls", async () => {
    let resolveFetch;
    const gate = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => gate);
    vi.stubGlobal("fetch", fetchMock);

    const first = useProviderStore.getState().fetchProviders({ force: true });
    const second = useProviderStore.getState().fetchProviders({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: () => Promise.resolve({ connections: [{ id: "a" }] }) });
    await Promise.all([first, second]);
    expect(useProviderStore.getState().providers).toEqual([{ id: "a" }]);
    expect(useProviderStore.getState().loading).toBe(false);
  });

  it("leaves error null after failure then success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "boom" }) })),
    );
    await useProviderStore.getState().fetchProviders({ force: true });
    expect(useProviderStore.getState().error).toBe("boom");

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ connections: [] }) })),
    );
    await useProviderStore.getState().fetchProviders({ force: true });
    expect(useProviderStore.getState().error).toBeNull();
  });
});
