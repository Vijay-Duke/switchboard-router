import { describe, expect, it } from "vitest";
import { refreshIdentityVersions, shouldRefresh } from "../../scripts/refresh-identity-versions.mjs";

const versionsFile = new URL("../../open-sse/identity/snapshots/versions.json", import.meta.url);

const fresh = "2026-08-20T00:00:00.000Z";
const old = "2026-08-01T00:00:00.000Z";
const now = Date.parse("2026-08-22T00:00:00.000Z");

function fetchVersion(version) {
  return async () => new Response(JSON.stringify({ version }), { status: 200 });
}

describe("identity fallback version refresh", () => {
  it("enforces the seven-day grace period", () => {
    expect(shouldRefresh({ releasedAt: fresh }, now)).toBe(false);
    expect(shouldRefresh({ releasedAt: old }, now)).toBe(true);
  });

  it("checks stale fallback versions without writing", async () => {
    const file = versionsFile;
    const staleNow = Date.parse("2026-08-30T00:00:00.000Z");
    await expect(refreshIdentityVersions({ file, now: staleNow, fetchImpl: fetchVersion("99.0.0") }))
      .rejects.toThrow("Identity fallback versions exceed 7-day grace");
  });

  it("never rewrites Claude's captured wire version", async () => {
    const file = versionsFile;
    const snapshots = await refreshIdentityVersions({ file, now, fetchImpl: fetchVersion("2.1.240") });
    expect(snapshots["claude-cli"].version).toBe("2.1.220");
    expect(snapshots["claude-cli"].latestVersion).toBe("2.1.239");
  });

  it("requires a new Claude capture even when npm latest is already recorded", async () => {
    const file = versionsFile;
    const staleNow = Date.parse("2026-08-30T00:00:00.000Z");
    await expect(refreshIdentityVersions({ file, now: staleNow, fetchImpl: fetchVersion("2.1.239") }))
      .rejects.toThrow("claude-cli: captured 2.1.220 → 2.1.239");
  });
});
