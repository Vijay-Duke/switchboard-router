import { describe, expect, it } from "vitest";

import { assertPublicUrl, assertPublicUrlResolved } from "../../open-sse/utils/ssrfGuard.js";

describe("SSRF guard IPv4-mapped IPv6 handling", () => {
  it("rejects hexadecimal IPv4-mapped loopback addresses", () => {
    expect(() => assertPublicUrl("http://[::ffff:7f00:1]/metadata")).toThrow(/private IP/);
  });
});

describe("SSRF guard allow list", () => {
  it("blocks a private IP literal by default", () => {
    expect(() => assertPublicUrl("http://10.0.0.5/")).toThrow(/private IP/);
  });

  it("lets an allow-listed IP literal through the sync check", () => {
    expect(() => assertPublicUrl("http://10.0.0.5/", ["10.0.0.5"])).not.toThrow();
  });

  it("matches allow-list entries case- and bracket-insensitively", () => {
    expect(() => assertPublicUrl("http://[::1]/", ["::1"])).not.toThrow();
    expect(() => assertPublicUrl("http://Example.Internal/", ["example.internal"])).not.toThrow();
  });

  it("ignores an allow list that does not match the host", () => {
    expect(() => assertPublicUrl("http://10.0.0.5/", ["other.host"])).toThrow(/private IP/);
  });

  it("skips the resolved-IP recheck for an allow-listed hostname (internal gateway on a VPN IP)", async () => {
    // Host would normally be re-checked after DNS resolution; allow-listing the
    // hostname short-circuits before resolution so a private-IP gateway works.
    await expect(
      assertPublicUrlResolved("https://gateway.example.com/", ["gateway.example.com"])
    ).resolves.toBeUndefined();
  });

  it("still blocks non-allow-listed hosts through the resolved path", async () => {
    await expect(assertPublicUrlResolved("http://127.0.0.1/")).rejects.toThrow(/internal host|private IP/);
  });
});
