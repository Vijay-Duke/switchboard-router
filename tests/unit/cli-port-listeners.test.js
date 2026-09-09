import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { listenerConflicts, parseListenerAddress } = require("../../cli/src/cli/processManager");

describe("CLI port-listener conflict rules", () => {
  // The Tailscale-serve pattern: tailscaled holds a specific tailnet IP and
  // forwards to loopback — the app must still bind wildcard/loopback.
  it("treats a specific-address listener as coexisting with a wildcard bind", () => {
    const tailscale = parseListenerAddress("[fd7a:115c:a1e0::3328:9776]:20128", "IPv6");
    expect(listenerConflicts(tailscale, "0.0.0.0")).toBe(false);

    const tailscaleV4 = parseListenerAddress("100.121.151.117:20128", "IPv4");
    expect(listenerConflicts(tailscaleV4, "0.0.0.0")).toBe(false);
    expect(listenerConflicts(tailscaleV4, "127.0.0.1")).toBe(false);
  });

  it("blocks a wildcard listener against a same-family bind", () => {
    expect(listenerConflicts(parseListenerAddress("*:20128", "IPv4"), "0.0.0.0")).toBe(true);
    expect(listenerConflicts(parseListenerAddress("*:20128", "IPv4"), "127.0.0.1")).toBe(true);
    // IPv6 wildcard does not claim an IPv4 bind
    expect(listenerConflicts(parseListenerAddress("*:20128", "IPv6"), "0.0.0.0")).toBe(false);
  });

  it("blocks a specific listener only when it claims the exact bind address", () => {
    const lan = parseListenerAddress("192.168.50.10:20128", "IPv4");
    expect(listenerConflicts(lan, "192.168.50.10")).toBe(true);
    expect(listenerConflicts(lan, "192.168.50.11")).toBe(false);
    expect(listenerConflicts(lan, "0.0.0.0")).toBe(false);
  });

  it("normalizes the shapes lsof and Get-NetTCPConnection produce", () => {
    expect(parseListenerAddress("127.0.0.1:20128", "IPv4")).toMatchObject({ address: "127.0.0.1", family: 4, wildcard: false });
    expect(parseListenerAddress("*:20128", "IPv6")).toMatchObject({ wildcard: true, family: 6 });
    expect(parseListenerAddress("0.0.0.0", null)).toMatchObject({ wildcard: true, family: 4 });
    expect(parseListenerAddress("::", null)).toMatchObject({ wildcard: true, family: 6 });
    expect(parseListenerAddress("[fd7a::1]:20128", "IPv6")).toMatchObject({ address: "fd7a::1", family: 6 });
  });

  it("fails closed for unknown listener shapes", () => {
    expect(listenerConflicts(null, "0.0.0.0")).toBe(true);
    expect(listenerConflicts(undefined, "127.0.0.1")).toBe(true);
  });
});
