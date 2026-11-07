// kiro.dev's legacy path gateway 400s modern payloads (terminal), so every
// auth method tries the Amazon surfaces first. (ported from upstream 35b950be)
import { describe, it, expect } from "vitest";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

describe("Kiro surface ordering", () => {
  it("never puts kiro.dev first, even for social OAuth tokens", () => {
    const ex = new KiroExecutor();
    const urls = ex.getOrderedBaseUrls({ accessToken: "tok", providerSpecificData: { authMethod: "social" } });
    expect(urls[0]).toContain("amazonaws.com");
    expect(urls.at(-1)).toContain("kiro.dev");
  });

  it("sends the SSO bearer, agent-mode and profile headers", () => {
    const ex = new KiroExecutor();
    const headers = ex.buildHeaders({ accessToken: "tok", providerSpecificData: { authMethod: "social", profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/ABC" } }, true);
    expect(headers["x-amz-sso-bearer"]).toBe("tok");
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("spec");
    expect(headers["x-amzn-codewhisperer-profile-arn"]).toBe("arn:aws:codewhisperer:us-east-1:123:profile/ABC");
  });
});
