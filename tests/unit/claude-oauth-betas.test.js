import { describe, it, expect } from "vitest";
import { withClaudeOAuthCredentialBetas, withoutClaudeCodeBeta } from "../../open-sse/identity/wrap.js";

// CLIProxyAPI parity: a Bearer (OAuth) claude request must declare
// oauth-2025-04-20 right after claude-code-20250219, plus
// extended-cache-ttl-2025-04-11; caller-supplied betas keep their position.
describe("withClaudeOAuthCredentialBetas", () => {
  it("inserts the oauth beta directly after claude-code-20250219", () => {
    const out = withClaudeOAuthCredentialBetas("claude-code-20250219,interleaved-thinking-2025-05-14");
    expect(out.split(",")).toEqual([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "extended-cache-ttl-2025-04-11",
    ]);
  });

  it("leaves existing oauth beta in place and appends only cache-ttl", () => {
    const out = withClaudeOAuthCredentialBetas("claude-code-20250219,oauth-2025-04-20,effort-2025-11-24");
    expect(out.split(",")).toEqual([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "effort-2025-11-24",
      "extended-cache-ttl-2025-04-11",
    ]);
  });

  it("is idempotent and handles empty/malformed input", () => {
    const once = withClaudeOAuthCredentialBetas("claude-code-20250219,a,b");
    expect(withClaudeOAuthCredentialBetas(once)).toBe(once);
    expect(withClaudeOAuthCredentialBetas("")).toBe("oauth-2025-04-20,extended-cache-ttl-2025-04-11");
    expect(withClaudeOAuthCredentialBetas("x,,x, y ")).toBe("oauth-2025-04-20,x,y,extended-cache-ttl-2025-04-11");
  });

  it("inserts at the front when claude-code beta is absent", () => {
    expect(withClaudeOAuthCredentialBetas("effort-2025-11-24").split(",")[0]).toBe("oauth-2025-04-20");
  });
});

// API-key hops must not send the Claude Code subscription-surface beta:
// with a user-scoped key Anthropic bills it against an empty surface and
// answers 400 "credit balance too low" on funded accounts. OAuth hops
// keep it (see above).
describe("withoutClaudeCodeBeta", () => {
  it("removes only claude-code-20250219, preserving order and the rest", () => {
    expect(
      withoutClaudeCodeBeta("claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24")
    ).toBe("interleaved-thinking-2025-05-14,effort-2025-11-24");
  });

  it("matches the flag exactly, not as a substring", () => {
    expect(withoutClaudeCodeBeta("xclaude-code-20250219x,interleaved-thinking-2025-05-14")).toBe(
      "xclaude-code-20250219x,interleaved-thinking-2025-05-14"
    );
  });

  it("is idempotent and handles empty/malformed input", () => {
    const once = withoutClaudeCodeBeta("claude-code-20250219,a, b ");
    expect(once).toBe("a,b");
    expect(withoutClaudeCodeBeta(once)).toBe(once);
    expect(withoutClaudeCodeBeta("")).toBe("");
    expect(withoutClaudeCodeBeta("claude-code-20250219")).toBe("");
    expect(withoutClaudeCodeBeta(null)).toBe("");
  });
});
