/**
 * Overview endpoint URL list — server NIC enumeration plus the browser's own
 * origin, so every way to reach /v1 is shown with a working scheme.
 */

import { describe, it, expect } from "vitest";
import { buildEndpointList, isTailscaleIp } from "@/lib/network/endpointUrls";
import { getServerEndpointUrls } from "@/lib/network/endpointUrlsServer";

function nic(address, { internal = false, family = "IPv4" } = {}) {
  return { address, family, internal, mac: "00:00:00:00:00:00", netmask: "255.255.255.0" };
}

describe("getServerEndpointUrls", () => {
  it("always lists loopback first", () => {
    const urls = getServerEndpointUrls(20128, {});
    expect(urls).toEqual([{ label: "Local", url: "http://127.0.0.1:20128/v1" }]);
  });

  it("labels Tailscale and LAN addresses, Tailscale first", () => {
    const urls = getServerEndpointUrls(20128, {
      en0: [nic("192.168.1.10")],
      tailscale0: [nic("100.121.151.117")],
    });
    expect(urls).toEqual([
      { label: "Local", url: "http://127.0.0.1:20128/v1" },
      { label: "Tailscale", url: "http://100.121.151.117:20128/v1" },
      { label: "LAN", url: "http://192.168.1.10:20128/v1" },
    ]);
  });

  it("skips internal, link-local, IPv6, and duplicate addresses", () => {
    const urls = getServerEndpointUrls(20128, {
      lo0: [nic("127.0.0.1", { internal: true }), { ...nic("::1"), family: "IPv6", internal: true }],
      en0: [nic("169.254.10.20"), { ...nic("fe80::1"), family: "IPv6" }, nic("192.168.1.10")],
      utun9: [nic("192.168.1.10")],
    });
    expect(urls).toEqual([
      { label: "Local", url: "http://127.0.0.1:20128/v1" },
      { label: "LAN", url: "http://192.168.1.10:20128/v1" },
    ]);
  });

  it("disambiguates repeated labels with the interface name", () => {
    const urls = getServerEndpointUrls(20128, {
      en0: [nic("192.168.1.10")],
      en1: [nic("10.0.0.5")],
    });
    expect(urls.map((e) => e.label)).toEqual(["Local", "LAN (en0)", "LAN (en1)"]);
  });

  it("uses the configured port", () => {
    const urls = getServerEndpointUrls(9999, { tailscale0: [nic("100.99.0.2")] });
    expect(urls[1].url).toBe("http://100.99.0.2:9999/v1");
  });
});

describe("isTailscaleIp", () => {
  it("matches the 100.64/10 CGNAT range only", () => {
    expect(isTailscaleIp("100.64.0.1")).toBe(true);
    expect(isTailscaleIp("100.127.255.254")).toBe(true);
    expect(isTailscaleIp("100.63.9.9")).toBe(false);
    expect(isTailscaleIp("100.128.0.1")).toBe(false);
    expect(isTailscaleIp("192.168.1.1")).toBe(false);
  });
});

describe("buildEndpointList", () => {
  const server = [
    { label: "Local", url: "http://127.0.0.1:20128/v1" },
    { label: "Tailscale", url: "http://100.121.151.117:20128/v1" },
  ];

  it("prepends the browser origin with its own scheme", () => {
    const list = buildEndpointList({
      serverUrls: server,
      browserOrigin: "https://vijays-mac-mini.taila52c2a.ts.net:8443",
    });
    expect(list[0]).toEqual({
      label: "This browser",
      url: "https://vijays-mac-mini.taila52c2a.ts.net:8443/v1",
    });
    expect(list).toHaveLength(3);
  });

  it("does not duplicate when the browser origin matches a server URL", () => {
    const list = buildEndpointList({
      serverUrls: server,
      browserOrigin: "http://100.121.151.117:20128",
    });
    expect(list).toEqual(server);
  });

  it("renders the server list alone before client hydration", () => {
    expect(buildEndpointList({ serverUrls: server })).toEqual(server);
    expect(buildEndpointList({})).toEqual([]);
  });
});
