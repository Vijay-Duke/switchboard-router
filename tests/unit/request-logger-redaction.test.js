import { describe, expect, it } from "vitest";

import { maskSensitiveHeaders } from "../../open-sse/utils/requestLogger.js";

describe("request logger credential redaction", () => {
  it("removes all native OAuth and Switchboard key material", () => {
    expect(maskSensitiveHeaders({
      authorization: "Bearer native-claude-oauth-secret",
      "x-switchboard-key": "sk-switchboard-secret",
      "user-agent": "claude-code/2.1.129",
    })).toEqual({
      authorization: "[redacted]",
      "x-switchboard-key": "[redacted]",
      "user-agent": "claude-code/2.1.129",
    });
  });
});
