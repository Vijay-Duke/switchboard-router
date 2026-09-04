import { describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({ default: { lookup }, lookup }));

const { isPrivateIp, assertSafeCatalogUrl } = await import("../../src/lib/agent-library/catalog.js");

describe("isPrivateIp IPv6 forms (L1)", () => {
  it.each([
    "::ffff:127.0.0.1",
    "0:0:0:0:0:0:0:1",
    "::1",
    "::",
    "0:0:0:0:0:0:0:0",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:127.0.0.1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::c0a8:1",
    "fc00::1",
    "fd12:3456::5",
    "fe80::1",
    "febf::1",
  ])("treats %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    "2001:db8::1",
    "2606:4700:4700::1111",
    "fec0::1",
    "::ffff:8.8.8.8",
    "64:ff9b::0808:0808",
    "8.8.8.8",
  ])("treats %s as public", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it.each(["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "0.0.0.0"])(
    "keeps IPv4 guard for %s",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(true);
    }
  );
});

describe("assertSafeCatalogUrl rejects private IPv6 DNS results (L1)", () => {
  it("rejects a host resolving to ::ffff:127.0.0.1", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "::ffff:127.0.0.1", family: 6 }]);
    const res = await assertSafeCatalogUrl("https://raw.githubusercontent.com/org/repo/main/SKILL.md");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("private_ip");
  });

  it("rejects a host resolving to NAT64-mapped loopback", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "64:ff9b::7f00:1", family: 6 }]);
    const res = await assertSafeCatalogUrl("https://raw.githubusercontent.com/org/repo/main/SKILL.md");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("private_ip");
  });
});
