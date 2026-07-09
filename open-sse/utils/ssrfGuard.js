// SSRF guard: block internal/private/metadata targets for server-side fetch.
// H5: also reject integer/octal/hex IP encodings and optionally DNS-resolve.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

// Parse dotted IPv4 to 32-bit integer, or null if not a valid IPv4 literal.
function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Private/reserved IPv4 ranges as [startInt, maskBits].
const BLOCKED_V4_RANGES = [
  [ipv4ToInt("0.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16],
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16],
  [ipv4ToInt("100.64.0.0"), 10], // CGNAT
];

function isBlockedIpv4Int(ip) {
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return isBlockedIpv4Int(ip);
}

function isBlockedIpv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4Mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isBlockedIpv4(v4Mapped[1]);
  if (h === "::1" || h === "::") return true;
  return h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd");
}

/** Decode decimal / octal / hex / bare-integer IPv4 encodings (e.g. 2130706433 → 127.0.0.1). */
function decodeWeirdIpv4(host) {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) return n >>> 0;
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) return n >>> 0;
  }
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(p))) {
    let value = 0;
    for (const part of parts) {
      let octet;
      if (/^0x/i.test(part)) octet = parseInt(part, 16);
      else if (part.startsWith("0") && part.length > 1) octet = parseInt(part, 8);
      else octet = parseInt(part, 10);
      if (!Number.isFinite(octet) || octet < 0 || octet > 255) return null;
      value = value * 256 + octet;
    }
    return value >>> 0;
  }
  return null;
}

function assertHostSafe(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTNAMES.has(h)) throw new Error("Blocked URL: internal host");
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) throw new Error("Blocked URL: internal host");

  const weird = decodeWeirdIpv4(h);
  if (weird !== null && isBlockedIpv4Int(weird)) throw new Error("Blocked URL: private IP");

  if (isBlockedIpv4(h)) throw new Error("Blocked URL: private IP");
  if (h.includes(":") && isBlockedIpv6(h)) throw new Error("Blocked URL: private IP");
  if (isIP(h) === 4 && isBlockedIpv4(h)) throw new Error("Blocked URL: private IP");
  if (isIP(h) === 6 && isBlockedIpv6(h)) throw new Error("Blocked URL: private IP");
}

// Sync check: hostnames + IP literals / encodings. Caller maps to 400.
export function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Blocked URL: invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Blocked URL: unsupported scheme");
  }
  assertHostSafe(parsed.hostname);
}

/**
 * Async: DNS-resolve hostname and re-check all A/AAAA addresses (anti DNS-rebind).
 * Use at fetch time for user-configured baseUrl.
 */
export async function assertPublicUrlResolved(rawUrl) {
  assertPublicUrl(rawUrl);
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Blocked URL: DNS resolution failed");
  }
  if (!records?.length) throw new Error("Blocked URL: DNS resolution failed");
  for (const rec of records) {
    assertHostSafe(rec.address);
  }
}
