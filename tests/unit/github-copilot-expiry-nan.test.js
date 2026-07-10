import { describe, it, expect } from "vitest";
import GithubExecutor from "../../open-sse/executors/github.js";

/**
 * Regression: a corrupt `copilotTokenExpiresAt` parsed to NaN, and every NaN
 * comparison is false — so `expiresAtMs - Date.now() < 5min` never fired and
 * the executor kept presenting a dead Copilot token until upstream 401'd.
 */
describe("GithubExecutor.needsRefresh copilot expiry", () => {
  const exec = new GithubExecutor();
  const withExpiry = (copilotTokenExpiresAt) => ({ copilotToken: "tok", copilotTokenExpiresAt });

  // A falsy expiry (null/0/NaN) means "not recorded" and defers to super; only
  // a truthy-but-unparseable value hit the NaN-comparison hole.
  it("refreshes when the expiry is present but unparseable", () => {
    for (const bad of ["not-a-date", "2024-13-45T99:99:99Z", "  "]) {
      expect(exec.needsRefresh(withExpiry(bad))).toBe(true);
    }
  });

  it("refreshes when the token is expired or near expiry", () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    expect(exec.needsRefresh(withExpiry(soon))).toBe(true);
    expect(exec.needsRefresh(withExpiry(Math.floor(Date.now() / 1000) - 10))).toBe(true);
  });

  it("does not force a refresh for a token valid well into the future", () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(exec.needsRefresh(withExpiry(later))).toBe(false);
  });
});
