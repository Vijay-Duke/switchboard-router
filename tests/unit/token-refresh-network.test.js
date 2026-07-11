import { describe, expect, it, vi } from "vitest";

import { checkAndRefreshToken } from "../../src/sse/services/tokenRefresh.js";

describe("proactive token refresh network failures", () => {
  it("keeps the current credentials when the refresh endpoint is unreachable", async () => {
    const credentials = {
      connectionId: "github-1",
      accessToken: "old-access",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      providerSpecificData: {},
    };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    await expect(checkAndRefreshToken("github", credentials)).resolves.toMatchObject({
      accessToken: "old-access",
      refreshToken: "refresh-token",
    });

    vi.unstubAllGlobals();
  });
});
