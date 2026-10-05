// @ts-check
/**
 * Endpoint URL helpers shared by the dashboard server + client.
 * Pure and browser-safe — the `node:os` NIC enumeration lives in
 * `./endpointUrlsServer.js` (server components only).
 *
 * The server only speaks plain HTTP itself (any TLS in front of it belongs to
 * the operator's own proxy), so server-enumerated URLs are `http://<ip>:port/v1`.
 * The browser's own origin is prepended client-side and keeps its scheme —
 * that is the only entry that can know about an https proxy in front.
 */

/**
 * @typedef {object} EndpointUrlEntry
 * @property {string} label - Short UI label ("Local", "Tailscale", "LAN", ...).
 * @property {string} url - Full base URL including `/v1`.
 */

/**
 * Tailscale assigns from the CGNAT range 100.64.0.0/10.
 * @param {string} ip
 */
export function isTailscaleIp(ip) {
  const parts = ip.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts[0] === 100 &&
    Number.isInteger(parts[1]) &&
    parts[1] >= 64 &&
    parts[1] <= 127
  );
}

/**
 * Merge the server list with the browser's own origin (client-side only —
 * `window.location.origin` is unavailable during SSR). The browser entry
 * comes first unless it duplicates a server URL.
 *
 * @param {{ serverUrls?: EndpointUrlEntry[]|null, browserOrigin?: string|null }} args
 * @returns {EndpointUrlEntry[]}
 */
export function buildEndpointList({ serverUrls = null, browserOrigin = null } = {}) {
  const list = Array.isArray(serverUrls) ? [...serverUrls] : [];
  if (browserOrigin) {
    const url = `${String(browserOrigin).replace(/\/$/, "")}/v1`;
    if (!list.some((entry) => entry.url === url)) {
      list.unshift({ label: "This browser", url });
    }
  }
  return list;
}
