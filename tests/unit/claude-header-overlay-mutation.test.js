import { describe, it, expect, beforeEach } from "vitest";
import DefaultExecutor from "../../open-sse/executors/default.js";
import { cacheClaudeHeaders, getCachedClaudeHeaders } from "../../open-sse/utils/claudeHeaderCache.js";

/**
 * Regression: claudeOverlay merged the request's static anthropic-beta flags
 * into the object returned by getCachedClaudeHeaders() — which is the live
 * module-level cache. Flags therefore accumulated across requests and leaked
 * from one model's request into every subsequent one.
 */
describe("claudeOverlay header hook", () => {
  beforeEach(() => {
    cacheClaudeHeaders({
      "user-agent": "claude-cli/1.0.0",
      "anthropic-beta": "cached-flag",
    });
  });

  const buildFor = (staticBeta) => {
    const exec = new DefaultExecutor("claude");
    exec.config = { ...exec.config, headers: { "anthropic-beta": staticBeta } };
    return exec.buildHeaders({ apiKey: "sk-test" }, false);
  };

  it("never mutates the cached header object", () => {
    const before = getCachedClaudeHeaders()["anthropic-beta"];
    buildFor("request-a-flag");
    expect(getCachedClaudeHeaders()["anthropic-beta"]).toBe(before);
  });

  it("does not leak one request's beta flags into the next", () => {
    const a = buildFor("request-a-flag");
    const b = buildFor("request-b-flag");

    expect(a["anthropic-beta"]).toContain("request-a-flag");
    expect(a["anthropic-beta"]).toContain("cached-flag");

    expect(b["anthropic-beta"]).toContain("request-b-flag");
    expect(b["anthropic-beta"]).toContain("cached-flag");
    expect(b["anthropic-beta"]).not.toContain("request-a-flag");
  });
});
