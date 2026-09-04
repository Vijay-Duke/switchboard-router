// @ts-check
// Match a configured CLI base URL against all known endpoints (local/tunnel/tailscale/cloud).
const stripTrailingSlash = (s) => (s || "").replace(/\/+$/, "");

// Exact hostnames only — an unanchored regex would also match spoofs like
// `localhost.evil.com`. `new URL(...).hostname` returns bracketed IPv6 (`[::1]`).
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

function isLocalUrl(url) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function matchKnownEndpoint(currentUrl, opts = {}) {
  if (!currentUrl) return false;
  const url = stripTrailingSlash(currentUrl);
  const { tunnelPublicUrl, tailscaleUrl, cloudUrl } = opts;
  if (isLocalUrl(url)) return true;
  const matchesEndpointBase = (base) => {
    const stripped = stripTrailingSlash(base);
    // Path-boundary match: `abc123.loca.lt.evil.com` must not prefix-match
    // the real `abc123.loca.lt`.
    return url === stripped || url.startsWith(`${stripped}/`);
  };
  if (tunnelPublicUrl && matchesEndpointBase(tunnelPublicUrl)) return true;
  if (tailscaleUrl && matchesEndpointBase(tailscaleUrl)) return true;
  if (cloudUrl && matchesEndpointBase(cloudUrl)) return true;
  return false;
}
