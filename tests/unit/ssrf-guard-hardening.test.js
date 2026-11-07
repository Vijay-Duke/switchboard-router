import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for #3714: the SSRF guard's literal-hostname/IP checks
// matched specific textual representations rather than the underlying address,
// so a different (but equivalent) representation slipped through. Each case
// below is a bypass the issue reported, or one found while fixing it.

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
// Switchboard's guard imports lookup from node:dns/promises.
vi.mock("node:dns/promises", () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
}));

// Upstream's fetchPublic() redirect wrapper is not ported: Switchboard's search
// handler already fetches with redirect: "error" and /v1/web/fetch resolves DNS
// before fetching, so only the literal/resolved-address cases apply here.
const { assertPublicUrl, assertPublicUrlResolved } = await import("../../src/shared/utils/ssrfGuard.js");

describe("assertPublicUrl: literal hostname/IP bypasses from #3714", () => {
  it("blocks a trailing-dot FQDN the same as the bare hostname", () => {
    expect(() => assertPublicUrl("http://localhost/")).toThrow();
    expect(() => assertPublicUrl("http://localhost./")).toThrow();
    expect(() => assertPublicUrl("http://LOCALHOST./")).toThrow();
  });

  it("blocks IPv4-mapped IPv6 loopback regardless of which textual form the URL parser picks", () => {
    // WHATWG URL parsing normalizes dotted-decimal IPv4-in-IPv6 to hex form —
    // the original regex only matched the dotted form.
    expect(() => assertPublicUrl("http://[::ffff:127.0.0.1]/")).toThrow();
    expect(() => assertPublicUrl("http://[::ffff:7f00:1]/")).toThrow(); // hex form directly
    expect(() => assertPublicUrl("http://[0000::ffff:127.0.0.1]/")).toThrow();
  });

  it("blocks IPv4-mapped IPv6 cloud metadata address (169.254.169.254)", () => {
    expect(() => assertPublicUrl("http://[::ffff:169.254.169.254]/")).toThrow();
    expect(() => assertPublicUrl("http://[::ffff:a9fe:a9fe]/")).toThrow(); // hex form
  });

  it("blocks other loopback/private/link-local/ULA IPv6 forms", () => {
    for (const url of [
      "http://[::1]/",
      "http://[::127.0.0.1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[64:ff9b::127.0.0.1]/", // NAT64 well-known prefix embedding a private IPv4
      "http://[64:ff9b::a9fe:a9fe]/", // NAT64 hex form of 169.254.169.254 (metadata)
      "http://[::a00:1]/", // IPv4-compatible hex form of 10.0.0.1
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("blocks alternate IPv4 literal encodings (already normalized by the URL parser)", () => {
    for (const url of ["http://127.1/", "http://0177.0.0.1/", "http://2130706433/", "http://0x7f.0.0.1/"]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("still allows public hosts, including public IPv6", () => {
    expect(() => assertPublicUrl("https://api.openai.com/v1/models")).not.toThrow();
    expect(() => assertPublicUrl("http://8.8.8.8/")).not.toThrow();
    expect(() => assertPublicUrl("https://[2001:4860:4860::8888]/")).not.toThrow();
  });
});

describe("assertPublicUrlResolved: DNS-resolving hostname bypass from #3714", () => {
  beforeEach(() => lookupMock.mockReset());

  it("blocks a hostname that resolves to a loopback address (nip.io-style wildcard DNS)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertPublicUrlResolved("http://127.0.0.1.nip.io/")).rejects.toThrow();
  });

  it("blocks a hostname that resolves to a private range even if one of several addresses is public", async () => {
    lookupMock.mockResolvedValue([{ address: "203.0.113.5", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    await expect(assertPublicUrlResolved("http://multi-a-record.example.test/")).rejects.toThrow();
  });

  it("blocks a hostname that resolves to a blocked IPv6 address", async () => {
    lookupMock.mockResolvedValue([{ address: "::1", family: 6 }]);
    await expect(assertPublicUrlResolved("http://evil.example.test/")).rejects.toThrow();
  });

  it("blocks a hostname that resolves to a NAT64 / IPv4-compatible private address", async () => {
    lookupMock.mockResolvedValue([{ address: "64:ff9b::7f00:1", family: 6 }]);
    await expect(assertPublicUrlResolved("http://nat64.example.test/")).rejects.toThrow();
    lookupMock.mockResolvedValue([{ address: "::10.0.0.1", family: 6 }]);
    await expect(assertPublicUrlResolved("http://compat.example.test/")).rejects.toThrow();
  });

  it("allows a NAT64 address that embeds a public IPv4", async () => {
    lookupMock.mockResolvedValue([{ address: "64:ff9b::808:808", family: 6 }]);
    await expect(assertPublicUrlResolved("http://nat64-public.example.test/")).resolves.not.toThrow();
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicUrlResolved("https://example.com/")).resolves.not.toThrow();
  });

  // DNS-lookup rejection (fail-closed "DNS resolution failed") is not covered
  // here: a mocked node:dns rejection trips a vitest transform quirk in this
  // file (same as upstream noted). Verified directly with node against the
  // real module instead.

  it("skips DNS lookup entirely for literal IP hosts (already covered by the sync check)", async () => {
    await expect(assertPublicUrlResolved("http://127.0.0.1/")).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
