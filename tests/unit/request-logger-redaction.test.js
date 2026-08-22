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

  it("fully redacts every supported gateway key carrier", () => {
    const rawKey = "sk-switchboard-request-log-secret";
    for (const header of ["authorization", "x-switchboard-key", "x-api-key", "x-goog-api-key"]) {
      const output = maskSensitiveHeaders({ [header]: rawKey });
      expect(output[header]).toBe("[redacted]");
      expect(JSON.stringify(output)).not.toContain(rawKey);
    }
  });
});
