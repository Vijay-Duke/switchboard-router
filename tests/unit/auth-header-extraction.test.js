import { describe, expect, it } from "vitest";

import { extractApiKey } from "../../src/sse/services/auth.js";
import {
  CLAUDE_ROUTING_MODE_HEADER,
  CLAUDE_ROUTING_MODES,
  SWITCHBOARD_KEY_HEADER,
} from "../../src/shared/claudeGateway.js";

describe("gateway API-key header extraction", () => {
  it("prefers the dedicated Switchboard key over a native OAuth bearer token", () => {
    const request = new Request("http://localhost/v1/messages", {
      headers: {
        authorization: "Bearer claude-native-oauth",
        [SWITCHBOARD_KEY_HEADER]: "sk-switchboard",
      },
    });

    expect(extractApiKey(request)).toBe("sk-switchboard");
  });

  it("never treats native OAuth as the gateway key in pass-through mode", () => {
    const request = new Request("http://localhost/v1/messages", {
      headers: {
        authorization: "Bearer claude-native-oauth",
        [CLAUDE_ROUTING_MODE_HEADER]: CLAUDE_ROUTING_MODES.PASS_THROUGH,
      },
    });

    expect(extractApiKey(request)).toBeNull();
  });

  it("accepts Gemini's x-goog-api-key header", () => {
    const request = new Request("http://localhost/v1beta/models/gemini-pro:generateContent", {
      headers: { "x-goog-api-key": "sk-gemini" },
    });

    expect(extractApiKey(request)).toBe("sk-gemini");
  });
});
