/**
 * Outbound leak denylist. Never send Switchboard identity to a provider.
 * Applied at proxyAwareFetch before the hop leaves the process.
 */

const SWITCHBOARD_RE = /switchboard/i;
const SWITCHBOARD_UA_RE = /Switchboard\//i;
const SWITCHBOARD_GITHUB = "https://github.com/Vijay-Duke/switchboard-router";

const AUTH_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
]);

export const LEAK_PATTERNS = Object.freeze({
  SWITCHBOARD_RE,
  SWITCHBOARD_UA_RE,
  SWITCHBOARD_GITHUB,
});

function headerEntries(headers) {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  return Object.entries(headers);
}

function isAuthKey(name) {
  return AUTH_KEYS.has(String(name).toLowerCase());
}

function isDenylisted(name, value) {
  const n = String(name);
  const v = value == null ? "" : String(value);
  const ln = n.toLowerCase();
  if (ln.startsWith("x-switchboard-")) return true;
  if (ln === "x-client-type" && /^switchboard$/i.test(v.trim())) return true;
  if (ln === "x-msh-platform" && /^switchboard$/i.test(v.trim())) return true;
  if (ln === "user-agent" && SWITCHBOARD_UA_RE.test(v)) return true;
  if (SWITCHBOARD_RE.test(n) && !isAuthKey(n)) return true;
  if (SWITCHBOARD_RE.test(v) && !isAuthKey(n)) return true;
  if (v.includes(SWITCHBOARD_GITHUB)) return true;
  return false;
}

/**
 * Drop denylisted names/values. Auth headers are kept even if the token
 * string happens to contain "switchboard" (gateway key, never forwarded
 * once wrap runs — but we must not strip a legitimate Bearer).
 * @param {Headers|Record<string, string>} headers
 * @returns {Record<string, string>}
 */
export function stripLeaks(headers) {
  const out = {};
  for (const [name, value] of headerEntries(headers)) {
    if (value == null) continue;
    if (isDenylisted(name, value)) continue;
    out[name] = String(value);
  }
  return out;
}

/**
 * True if any remaining header would still leak Switchboard.
 * @param {Record<string, string>} headers
 */
export function hasLeak(headers) {
  for (const [name, value] of headerEntries(headers)) {
    if (isDenylisted(name, value)) return true;
  }
  return false;
}
