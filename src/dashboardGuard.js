import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/db/index.js";
import { hasValidCliToken } from "@/shared/utils/cliToken.js";
import { isManagementTokenValid } from "@/lib/mgmt/token.js";

// Public LLM API prefixes (optional API-key gate for non-local callers).
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex"];

// Spawn-capable / host-secret routes — loopback or CLI token only.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  // Learning promote/relearn — loopback or CLI token only (SPEC §12)
  "/api/routing/learn",
  "/api/routing/versions/",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Strip the port and IPv6 brackets from a Host/authority value.
 * Handles `[::1]:20128`, `[::1]`, bare `::1`, `127.0.0.1:20128`, `::ffff:127.0.0.1`.
 * @param {string|null|undefined} h
 */
function normalizeHostname(h) {
  if (!h) return "";
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return "";
    name = name.slice(1, end);
  } else if (name.split(":").length === 2) {
    // host:port — a bare IPv6 literal always has >1 colon, so this is unambiguous.
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) name = name.slice(7); // IPv4-mapped IPv6
  return name;
}

function isLoopbackHostname(h) {
  const name = normalizeHostname(h);
  if (!name) return false;
  return LOOPBACK_HOSTS.has(name) || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/**
 * True only when this process is bound to a loopback address, so the kernel
 * itself guarantees every peer is local. HOSTNAME unset means Next binds
 * 0.0.0.0 — treat as public (the npm scripts default it to 127.0.0.1).
 */
function isLoopbackBind() {
  return isLoopbackHostname(process.env.HOSTNAME);
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!/^\d{1,3}$/.test(part) || octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/**
 * Operator-declared peer addresses that count as local, e.g. a Docker bridge
 * gateway. Opt-in via SWITCHBOARD_LOCAL_PEERS="172.17.0.0/16,172.18.0.1".
 * Only ever applied to the socket-derived IP, never to a client header.
 * @param {string} ip already normalized (port/brackets stripped)
 */
function isAllowlistedPeer(ip) {
  const raw = process.env.SWITCHBOARD_LOCAL_PEERS;
  if (!raw) return false;
  const addr = ipv4ToInt(ip);
  for (const entry of raw.split(",")) {
    const cidr = entry.trim();
    if (!cidr) continue;
    const [network, bitsRaw] = cidr.split("/");
    if (bitsRaw === undefined) {
      if (cidr.toLowerCase() === ip) return true; // exact match (incl. IPv6)
      continue;
    }
    const net = ipv4ToInt(network);
    const bits = Number(bitsRaw);
    if (addr === null || net === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    // bits===0 would make the shift a no-op in JS; it also means "everything".
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if (((addr & mask) >>> 0) === ((net & mask) >>> 0)) return true;
  }
  return false;
}

/** A socket-derived peer address we are willing to treat as local. */
function isTrustedPeer(ip) {
  const name = normalizeHostname(ip);
  if (!name) return false;
  return isLoopbackHostname(name) || isAllowlistedPeer(name);
}

/**
 * Loopback detection — locality must never be derived from a client-controlled
 * header. `Host` is attacker-controlled: a remote client can send
 * `Host: localhost` and would otherwise be handed every credential route.
 *
 * A request is local only when BOTH hold:
 *
 *  1. The peer is trusted. Either `x-switchboard-real-ip` — trustworthy only
 *     when custom-server.js set SWITCHBOARD_TRUST_REAL_IP=1, since it deletes
 *     any client copy and rewrites the value from the TCP socket — or a
 *     loopback process bind, where no remote peer can connect at all.
 *     Anything else (bare `next start` on 0.0.0.0) fails closed: use
 *     `npm run start:standalone` or a CLI token / API key.
 *
 *  2. `Host` is loopback. The peer check alone lets a trusted-but-hostile name
 *     (`Host: evil.example` resolving to 127.0.0.1) drive a DNS-rebinding
 *     attack from a local browser, so it is required in BOTH branches.
 *
 * Origin is then checked as a CSRF guard on top.
 */
export function isLocalRequest(request) {
  if (request.headers.get("x-switchboard-via-proxy")) return false;
  const trustRealIp = process.env.SWITCHBOARD_TRUST_REAL_IP === "1";
  // custom-server.js always sets the real-ip header; a missing value means the
  // request did not come through it → untrusted.
  const peerIsLocal = trustRealIp
    ? isTrustedPeer(request.headers.get("x-switchboard-real-ip"))
    : isLoopbackBind();
  if (!peerIsLocal) return false;
  // DNS-rebinding defense — required even when the socket says the peer is local.
  if (!isLoopbackHostname(request.headers.get("host"))) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function extractApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = request.headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  // M9: query-string keys land in access logs / Referer — headers only.
  return null;
}

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  // Local single-user: loopback always allowed. Non-local needs API key or CLI token.
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  // C1: requireApiKey defaults true. Opt-out only via settings or REQUIRE_API_KEY=false.
  try {
    const settings = await getSettings();
    if (settings?.requireApiKey === false) return true;
  } catch {
    // Fail closed when settings unreadable
    return await hasValidApiKey(request);
  }
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  if (isLocalRequest(request)) return true;
  return false;
}

async function canAccessManagementRoute(request) {
  return (await canAccessLocalOnlyRoute(request)) || isManagementTokenValid(request);
}

export const __test__ = {
  isLocalRequest,
  isLoopbackHostname,
  normalizeHostname,
  isTrustedPeer,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
  canAccessManagementRoute,
  isManagementTokenValid,
};

/**
 * Single-user local gateway: no dashboard login / OIDC / JWT.
 * - Public LLM prefixes: optional API key for non-loopback when requireApiKey.
 * - All other /api/*: loopback or CLI token only (credentials must not hit LAN).
 */
export async function proxy(request) {
  const { pathname } = request.nextUrl;

  if (LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "Local only" }, { status: 403 });
    }
  }

  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    return NextResponse.json({ error: "API key required" }, { status: 401 });
  }

  if (pathname.startsWith("/api/mgmt/")) {
    if (await canAccessManagementRoute(request)) return NextResponse.next();
    return NextResponse.json({ v: 1, error: { message: "Management API: unauthorized" } }, { status: 401 });
  }

  // All other /api/* (settings, keys, providers, combos writes, …) are loopback/CLI only.
  // Default bind is 0.0.0.0 — without this, LAN peers can mutate credentials.
  if (pathname.startsWith("/api/")) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "Local only" }, { status: 403 });
    }
  }

  // Dashboard HTML pages: open for local browser; data comes via gated /api/*
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
