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

describe("SSRF guard literal hardening", () => {
  it("blocks trailing-dot forms of blocked hostnames", () => {
    expect(() => assertPublicUrl("http://localhost./x")).toThrow(/internal host/);
    expect(() => assertPublicUrl("http://metadata.google.internal./x")).toThrow(/internal host/);
  });

  it("still accepts trailing-dot public hostnames", () => {
    expect(() => assertPublicUrl("http://example.com./x")).not.toThrow();
  });

  it("blocks full-form IPv6 loopback and unspecified literals", () => {
    expect(() => assertPublicUrl("http://[0:0:0:0:0:0:0:1]:8080/x")).toThrow(/private IP/);
    expect(() => assertPublicUrl("http://[0:0:0:0:0:0:0:0]/x")).toThrow(/private IP/);
    expect(() => assertPublicUrl("http://[fe80:0000:0000:0000:0000:0000:0000:0001]/x")).toThrow(/private IP/);
  });

  it("blocks inet_aton shorthand IPv4 that getaddrinfo resolves", () => {
    expect(() => assertPublicUrl("http://127.1/x")).toThrow(/private IP/);
    expect(() => assertPublicUrl("http://127.0.1/x")).toThrow(/private IP/);
    expect(() => assertPublicUrl("http://169.254.1/x")).toThrow(/private IP/);
  });

  it("does not block decimal-looking multi-label public hostnames", () => {
    // "1.2" as a hostname would resolve via DNS, not inet_aton shorthand —
    // only resolvable numeric shorthands are treated as IP literals.
    expect(() => assertPublicUrl("http://1.2/x")).not.toThrow();
  });
});
