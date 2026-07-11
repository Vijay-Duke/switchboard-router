import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../src/lib/db/repos/connectionsRepo.js";

/**
 * Regression: the provider connection API routes hid only top-level secret
 * fields (apiKey/accessToken/refreshToken/idToken) and returned
 * providerSpecificData verbatim — leaking nested plaintext secrets
 * (copilotToken, clientSecret, idToken, cookies, accessToken) in GET/PUT/POST
 * responses. redactSecrets walks the whole object using the same SECRET_FIELDS
 * list as at-rest encryption.
 */
describe("redactSecrets", () => {
  const conn = () => ({
    id: "abc",
    provider: "github",
    name: "acct",
    apiKey: "sk-top",
    accessToken: "at-top",
    providerSpecificData: {
      nodeName: "keepme",
      region: "us-east-1",
      copilotToken: "COPILOT_SECRET",
      idToken: "ID_SECRET",
      clientSecret: "CLIENT_SECRET",
      cookies: "COOKIE_SECRET",
      nested: { refreshToken: "DEEP_SECRET" },
    },
  });

  it("strips secrets at every depth but keeps non-secret fields", () => {
    const out = redactSecrets(conn());
    const dumped = JSON.stringify(out);

    for (const leak of [
      "sk-top", "at-top", "COPILOT_SECRET", "ID_SECRET",
      "CLIENT_SECRET", "COOKIE_SECRET", "DEEP_SECRET",
    ]) {
      expect(dumped, `leaked ${leak}`).not.toContain(leak);
    }

    // structure + non-secret data preserved
    expect(out.id).toBe("abc");
    expect(out.provider).toBe("github");
    expect(out.providerSpecificData.nodeName).toBe("keepme");
    expect(out.providerSpecificData.region).toBe("us-east-1");
  });

  it("does not mutate the input", () => {
    const c = conn();
    redactSecrets(c);
    expect(c.providerSpecificData.copilotToken).toBe("COPILOT_SECRET");
  });

  it("handles null/undefined without throwing", () => {
    expect(() => redactSecrets(null)).not.toThrow();
    expect(() => redactSecrets(undefined)).not.toThrow();
  });
});
