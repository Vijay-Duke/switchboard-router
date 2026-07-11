import { describe, it, expect, vi } from "vitest";

// We can't easily import the open-sse switch logic without real PROVIDERS config,
// so verify the wrapper function shape directly via dynamic import.

describe("xai/token-refresh wrapper", () => {
  it("refreshXaiToken module loads without throwing", async () => {
    // Just verify the file imports cleanly. The actual wrapper is internal.
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    expect(typeof mod.refreshTokenByProvider).toBe("function");
    expect(typeof mod.formatProviderCredentials).toBe("function");
  });

  it("formatProviderCredentials returns Bearer-shape for xai", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = mod.formatProviderCredentials(
      "xai",
      { apiKey: "k", accessToken: "t", refreshToken: "r" },
      null
    );
    expect(out).toEqual({ apiKey: "k", accessToken: "t" });
  });

  it("refreshTokenByProvider returns null when refreshToken missing", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = await mod.refreshTokenByProvider("xai", { refreshToken: "" }, null);
    expect(out).toBeNull();
  });

  it("refreshTokenByProvider returns expiresIn for refreshed xai tokens", async () => {
    vi.resetModules();
    // M11: open-sse no longer imports the app's XaiService directly — it asks
    // for it through the injected deps, so wire a fake factory instead.
    const { setOpenSseDeps } = await import("../../open-sse/runtimeDeps.js");
    setOpenSseDeps({
      createXaiService: async () => ({
        async refreshAccessToken(refreshToken) {
          return {
            access_token: "new-access",
            refresh_token: `${refreshToken}-rotated`,
            expires_in: 900,
            id_token: "id-token",
          };
        },
      }),
    });

    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = await mod.refreshTokenByProvider(
      "xai",
      { refreshToken: "old-refresh" },
      null
    );

    expect(out).toEqual({
      accessToken: "new-access",
      refreshToken: "old-refresh-rotated",
      expiresIn: 900,
      idToken: "id-token",
    });
    expect(out).not.toHaveProperty("expiresAt");

    vi.resetModules();
  });

  it("does not write raw refresh errors to the log", async () => {
    vi.resetModules();
    const { setOpenSseDeps } = await import("../../open-sse/runtimeDeps.js");
    setOpenSseDeps({
      createXaiService: async () => ({
        async refreshAccessToken() {
          throw new Error('400 {"error":"invalid_grant","refresh_token":"rt_secret"}');
        },
      }),
    });
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const warn = vi.fn();
    const out = await mod.refreshTokenByProvider("xai", { refreshToken: "rt_secret" }, { warn });

    expect(out).toEqual({ error: "invalid_grant" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("rt_secret");
    vi.resetModules();
  });
});
