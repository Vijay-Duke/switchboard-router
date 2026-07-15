import { describe, expect, it } from "vitest";

import {
  CLAUDE_ROUTING_MODE_HEADER,
  CLAUDE_ROUTING_MODES,
  isClaudePassThroughRequest,
} from "../../src/shared/claudeGateway.js";
import {
  getNativeClaudeCredentials,
} from "../../src/sse/services/claudePassThrough.js";

function request(headers = {}) {
  return new Request("http://localhost/v1/messages", { headers });
}

describe("Claude native OAuth pass-through", () => {
  it("classifies gateway mode through the canonical protocol helper", () => {
    expect(isClaudePassThroughRequest(request({
      [CLAUDE_ROUTING_MODE_HEADER.toUpperCase()]: CLAUDE_ROUTING_MODES.PASS_THROUGH.toUpperCase(),
    }).headers)).toBe(true);
    expect(isClaudePassThroughRequest(request({
      [CLAUDE_ROUTING_MODE_HEADER]: CLAUDE_ROUTING_MODES.PROXY,
    }).headers)).toBe(false);
  });

  it("creates ephemeral credentials only for a direct Anthropic request", () => {
    const credentials = getNativeClaudeCredentials({
      request: request({
        authorization: "Bearer native-claude-token",
        [CLAUDE_ROUTING_MODE_HEADER]: "pass-through",
      }),
      provider: "anthropic",
      allowNativeOAuth: true,
    });

    expect(credentials).toMatchObject({
      accessToken: "native-claude-token",
      connectionName: "Claude Code subscription",
      ephemeral: true,
    });
    expect(credentials).not.toHaveProperty("refreshToken");
  });

  it.each([
    ["openai", true],
    ["anthropic", false],
    ["claude", true],
  ])("does not expose the native token to provider %s when direct=%s", (provider, allowNativeOAuth) => {
    expect(getNativeClaudeCredentials({
      request: request({
        authorization: "Bearer native-claude-token",
        [CLAUDE_ROUTING_MODE_HEADER]: "pass-through",
      }),
      provider,
      allowNativeOAuth,
    })).toBeNull();
  });

  it("requires the explicit pass-through mode header", () => {
    expect(getNativeClaudeCredentials({
      request: request({ authorization: "Bearer native-claude-token" }),
      provider: "anthropic",
      allowNativeOAuth: true,
    })).toBeNull();
  });
});
