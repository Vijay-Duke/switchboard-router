import { describe, expect, it } from "vitest";

import { redactSecrets } from "../../src/lib/db/repos/connectionsRepo.js";

describe("connection secret redaction", () => {
  it("does not expose non-string secret values", () => {
    const redacted = redactSecrets({ apiKey: 123456, providerSpecificData: { refreshToken: false } });
    expect(redacted.apiKey).toBeUndefined();
    expect(redacted.providerSpecificData.refreshToken).toBeUndefined();
  });
});
