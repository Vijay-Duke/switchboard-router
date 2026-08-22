/**
 * refresh_token rotation between refreshWithRetry attempts (upstream aa0448f7).
 *
 * Simulates the reactive 401 flow in chatCore/embeddingsCore/imageGenerationCore:
 * executor.refreshCredentials consumes the old RT and returns a new one; the
 * retry callback must mutate `credentials` so attempt N+1 never replays a
 * consumed refresh_token (providers revoke sessions on replay).
 */

import { describe, it, expect, vi } from "vitest";

function makeRotationHarness() {
  const seen = [];
  const credentials = {
    accessToken: "at-old",
    refreshToken: "rt-old",
    expiresAt: Date.now() - 1000,
  };

  // Provider behavior: every refresh call consumes the CURRENT rt and issues
  // the next one; replaying a consumed rt throws (session revoked).
  let nextRtCounter = 1;
  const executor = {
    refreshCredentials: vi.fn(async (creds) => {
      seen.push(creds.refreshToken);
      if (seen.slice(0, -1).includes(creds.refreshToken)) {
        throw new Error("refresh_token already used — session revoked");
      }
      return {
        accessToken: `at-${nextRtCounter}`,
        refreshToken: `rt-${nextRtCounter++}`,
      };
    }),
  };

  // The exact retry-callback shape shipped in all three core handlers:
  const withCredentialRefreshLock = async (_provider, creds, fn) => fn();

  const attempt = async () => {
    const result = await withCredentialRefreshLock(
      "testprovider",
      credentials,
      () => executor.refreshCredentials(credentials, console),
    );
    if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
      if (result.accessToken) credentials.accessToken = result.accessToken;
      credentials.refreshToken = result.refreshToken;
    }
    return result;
  };

  return { credentials, executor, attempt, seen };
}

describe("refresh_token rotation across retry attempts", () => {
  it("each retry attempt sees the freshly rotated refresh token", async () => {
    const h = makeRotationHarness();
    await h.attempt(); // attempt 1: consumes rt-old → rt-1
    expect(h.credentials.refreshToken).toBe("rt-1");
    await h.attempt(); // attempt 2 must present rt-1, not rt-old
    expect(h.seen).toEqual(["rt-old", "rt-1"]);
    expect(h.executor.refreshCredentials).toHaveBeenCalledTimes(2);
    expect(h.credentials.refreshToken).toBe("rt-2");
    expect(h.credentials.accessToken).toBe("at-2");
  });

  it("a replayed (non-rotated) token triggers the provider revocation path", async () => {
    const h = makeRotationHarness();
    // Broken variant: no rotation applied → second attempt replays rt-old
    const brokenAttempt = async () => {
      await h.executor.refreshCredentials(h.credentials, console);
    };
    await brokenAttempt();
    await expect(brokenAttempt()).rejects.toThrow(/already used/);
  });

  it("rotation is a no-op when the provider returns no new refresh token", async () => {
    const credentials = { accessToken: "a", refreshToken: "keep-me" };
    const withCredentialRefreshLock = async (_p, _c, fn) => fn();
    const result = await withCredentialRefreshLock("p", credentials, async () => ({
      accessToken: "new-a",
      // no refreshToken in response
    }));
    if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
      credentials.refreshToken = result.refreshToken;
    }
    expect(credentials.refreshToken).toBe("keep-me");
    expect(credentials.accessToken).toBe("a"); // untouched: only a rotated RT applies fields
  });
});
