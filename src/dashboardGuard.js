import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER);
  if (!token) return false;
  return token === await getCliToken();
}

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

function isLoopbackHostname(h) {
  if (!h) return false;
  const name = h.split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(name);
}

/**
 * Loopback detection.
 * H1: `x-9r-real-ip` is only trustworthy when custom-server.js set
 * SWITCHBOARD_TRUST_REAL_IP=1 (it strips client copies and rewrites from the
 * TCP socket). Bare `next start` / `start:bun` leave that env unset, so a
 * client-spoofed x-9r-real-ip is ignored.
 *
 * Without that flag the only evidence left is the `Host` header, which the
 * client controls. That is sound ONLY while the server is bound to loopback —
 * then non-local packets can't arrive at all. If the bind host is public and
 * nothing derived the peer from the socket, locality is unprovable: fail closed.
 */
export function isLocalRequest(request) {
  if (request.headers.get("x-9r-via-proxy")) return false;
  const trustRealIp = process.env.SWITCHBOARD_TRUST_REAL_IP === "1";
  const realIp = trustRealIp ? request.headers.get("x-9r-real-ip") : null;
  if (realIp) {
    if (!isLoopbackHostname(realIp)) return false;
  } else {
    if (!trustRealIp && !isLoopbackHostname(process.env.HOSTNAME || "127.0.0.1")) return false;
    if (!isLoopbackHostname(request.headers.get("host"))) return false;
  }
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

export const __test__ = {
  isLocalRequest,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
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
