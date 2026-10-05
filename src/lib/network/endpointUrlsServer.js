// @ts-check
/**
 * Server-only endpoint URL enumeration (reads `node:os` NICs).
 * Never import from a client component — ship the result via initialData.
 */

import os from "node:os";
import { isTailscaleIp } from "./endpointUrls.js";

/**
 * @typedef {import("./endpointUrls.js").EndpointUrlEntry} EndpointUrlEntry
 */

/**
 * Enumerate reachable `http://<ip>:port/v1` URLs from the server's NICs.
 * Loopback first, then Tailscale, then other LAN IPv4. Skips link-local
 * (169.254/16) and IPv6 — neither is a useful client base URL.
 *
 * @param {number} port - Local endpoint port (see getLocalEndpointPort).
 * @param {NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>} [interfaces]
 * @returns {EndpointUrlEntry[]}
 */
export function getServerEndpointUrls(port, interfaces = os.networkInterfaces()) {
  /** @type {{ label: string, url: string, iface: string }[]} */
  const lan = [];
  const seen = new Set(["127.0.0.1"]);

  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (seen.has(ip)) continue;
      if (ip.startsWith("169.254.")) continue;
      seen.add(ip);
      lan.push({
        label: isTailscaleIp(ip) ? "Tailscale" : "LAN",
        url: `http://${ip}:${port}/v1`,
        iface: name,
      });
    }
  }

  // Tailscale before plain LAN; stable otherwise.
  lan.sort((a, b) => Number(b.label === "Tailscale") - Number(a.label === "Tailscale"));

  // Disambiguate repeats ("LAN" x2 → "LAN (en0)").
  const labelCounts = new Map();
  for (const entry of lan) {
    labelCounts.set(entry.label, (labelCounts.get(entry.label) || 0) + 1);
  }

  /** @type {EndpointUrlEntry[]} */
  const entries = [{ label: "Local", url: `http://127.0.0.1:${port}/v1` }];
  for (const entry of lan) {
    const suffix = (labelCounts.get(entry.label) || 0) > 1 ? ` (${entry.iface})` : "";
    entries.push({ label: `${entry.label}${suffix}`, url: entry.url });
  }
  return entries;
}
