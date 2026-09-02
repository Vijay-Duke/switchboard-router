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
    const snapshots = await refreshIdentityVersions({ file, now, fetchImpl: fetchVersion("2.1.259") });
    expect(snapshots["claude-cli"].version).toBe("2.1.258");
    expect(snapshots["claude-cli"].latestVersion).toBe("2.1.258");
  });

  it("requires a new Claude capture even when npm latest is already recorded", async () => {
    const file = versionsFile;
    const staleNow = Date.parse("2026-09-10T00:00:00.000Z");
    const fetchImpl = async (url) => new Response(JSON.stringify({
      version: url.includes("claude-code") ? "2.1.259" : url.includes("codex") ? "0.149.0" : "0.56.0",
    }), { status: 200 });
    await expect(refreshIdentityVersions({ file, now: staleNow, fetchImpl }))
      .rejects.toThrow("claude-cli: captured 2.1.258 → 2.1.259");
  });

  it("commits the complete measured Claude Code 2.1.258 tuple", async () => {
    const snapshots = JSON.parse(await (await import("node:fs/promises")).readFile(versionsFile, "utf8"));
    expect(snapshots["claude-cli"]).toMatchObject({
      version: "2.1.258",
      latestVersion: "2.1.258",
      tlsSpecRev: "claude-code-2.1.258",
      packageVersion: "0.112.1",
      runtimeVersion: "v26.3.0",
      entrypoint: "cli",
      betas: "claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,structured-outputs-2025-12-15",
    });
  });
});
