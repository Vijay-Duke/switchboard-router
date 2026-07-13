// SSRF guard: block internal/private/metadata targets for server-side fetch.
// H5: also reject integer/octal/hex IP encodings and optionally DNS-resolve.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

// Normalize a user-supplied host (or resolved IP) for allowlist comparison:
// lowercase and strip IPv6 brackets so "[::1]" and "::1" compare equal.
function normalizeHost(host) {
  return String(host).toLowerCase().replace(/^\[|\]$/g, "");
}

// Build a Set from the operator's trusted-host allowlist. These are hosts that
// resolve to private/internal IPs but are trusted anyway (e.g. an internal LLM
// gateway reached over VPN). The allowlist is persisted in settings and passed
// in at fetch time — the user opts a host in via the dashboard's
// "Add to allow list" button when an SSRF block is reported.
function toAllowSet(allowHosts) {
  if (!allowHosts) return null;
  const list = Array.isArray(allowHosts) ? allowHosts : [allowHosts];
  const set = new Set(list.map(normalizeHost).filter(Boolean));
  return set.size ? set : null;
}

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

function mappedIpv4FromIpv6(host) {
  const parts = host.split("::");
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) return null;

  const hextets = [...left, ...Array(missing).fill("0"), ...right];
  if (hextets.length !== 8 || hextets.slice(0, 5).some((part) => part !== "0") || hextets[5] !== "ffff") {
    return null;
  }

  const high = Number.parseInt(hextets[6], 16);
  const low = Number.parseInt(hextets[7], 16);
  if (![high, low].every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) return null;
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isBlockedIpv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4Mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const mappedIpv4 = v4Mapped?.[1] || mappedIpv4FromIpv6(h);
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
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

function assertHostSafe(host, allowSet = null) {
  const h = normalizeHost(host);

  if (allowSet?.has(h)) return; // user-trusted host
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
// allowHosts (array or string) opts specific trusted hosts past the guard.
export function assertPublicUrl(rawUrl, allowHosts = null) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Blocked URL: invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Blocked URL: unsupported scheme");
  }
  assertHostSafe(parsed.hostname, toAllowSet(allowHosts));
}

/**
 * Async: DNS-resolve hostname and re-check all A/AAAA addresses (anti DNS-rebind).
 * Use at fetch time for user-configured baseUrl.
 * allowHosts (array or string) opts specific trusted hosts past the guard —
 * an allowlisted hostname skips the resolved-IP recheck so an internal gateway
 * (e.g. one resolving to a private/VPN IP) can be reached once trusted.
 */
export async function assertPublicUrlResolved(rawUrl, allowHosts = null) {
  const allowSet = toAllowSet(allowHosts);
  assertPublicUrl(rawUrl, allowHosts);
  const parsed = new URL(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (allowSet?.has(host)) return; // trusted host: skip resolved-IP recheck
  if (isIP(host)) return;
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Blocked URL: DNS resolution failed");
  }
  if (!records?.length) throw new Error("Blocked URL: DNS resolution failed");
  for (const rec of records) {
    assertHostSafe(rec.address, allowSet);
  }
}
