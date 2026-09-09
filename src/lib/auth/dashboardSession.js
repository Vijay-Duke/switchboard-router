// @ts-check
/**
 * Remote-dashboard cookie sessions.
 *
 * The dashboard is local-first: loopback peers get in with no auth. A peer on
 * the LAN/VPN can sign in once with a gateway API key (`POST /api/auth/login`)
 * and receives an HttpOnly, SameSite=Lax cookie. The cookie carries a
 * stateless HMAC-signed token bound to this machine's secret (same
 * machine-id derivation as the CLI token), so verification needs no DB hit.
 *
 * Scope: dashboard pages + dashboard `/api/*` only. It never unlocks the
 * spawn-capable LOCAL_ONLY routes — those stay loopback/CLI-token.
 */
import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const DASHBOARD_SESSION_COOKIE = "switchboard_session";
export const DASHBOARD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SESSION_SALT = "switchboard-dashboard-session-v1";

/** @type {string|null} */
let cachedSecret = null;

/** Machine-bound HMAC key — rotating the machine id invalidates all sessions. */
async function getSessionSecret() {
  if (!cachedSecret) {
    cachedSecret = await getConsistentMachineId(SESSION_SALT);
  }
  return cachedSecret;
}

function hmac(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Mint a session token: `v1.<expiryEpochMs>.<hmac(secret, "sess:v1:" + expiry)>`.
 * @param {number} [ttlMs]
 */
export async function createDashboardSessionToken(ttlMs = DASHBOARD_SESSION_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const secret = await getSessionSecret();
  return `v1.${exp}.${hmac(secret, `sess:v1:${exp}`)}`;
}

/**
 * Constant-time verification of a session token minted by the above.
 * @param {string|null|undefined} token
 */
export async function verifyDashboardSessionToken(token) {
  if (typeof token !== "string" || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isInteger(exp) || exp <= Date.now()) return false;
  const secret = await getSessionSecret();
  const expected = Buffer.from(hmac(secret, `sess:v1:${exp}`), "utf8");
  const presented = Buffer.from(parts[2], "utf8");
  if (expected.length !== presented.length) return false;
  return crypto.timingSafeEqual(expected, presented);
}

/**
 * Read + verify the session cookie off a request. Works with Next middleware
 * requests (`request.cookies`) and plain `Request`s (header fallback).
 * @param {Request & { cookies?: { get?: (name: string) => unknown } }} request
 */
export async function hasValidDashboardSession(request) {
  let token = null;
  try {
    const fromJar = request?.cookies?.get?.(DASHBOARD_SESSION_COOKIE);
    token = typeof fromJar === "string" ? fromJar : fromJar?.value ?? null;
  } catch { /* fall through to header */ }
  if (!token) {
    const header = request?.headers?.get?.("cookie") || "";
    const match = header.match(new RegExp(`(?:^|;\\s*)${DASHBOARD_SESSION_COOKIE}=([^;]+)`));
    token = match ? decodeURIComponent(match[1]) : null;
  }
  return verifyDashboardSessionToken(token);
}

/**
 * Set-Cookie attributes for the session cookie. `secure` only on HTTPS —
 * plain-HTTP LAN access must keep working.
 * @param {string} token
 * @param {{ secure?: boolean, maxAgeSeconds?: number }} [options]
 */
export function dashboardSessionCookieAttributes(token, options = {}) {
  const maxAge = Math.floor((options.maxAgeSeconds ?? DASHBOARD_SESSION_TTL_MS / 1000));
  const flags = [
    `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) flags.push("Secure");
  return flags.join("; ");
}

/** Test helper — clears the cached machine secret. */
export function __resetDashboardSessionCacheForTests() {
  cachedSecret = null;
}
