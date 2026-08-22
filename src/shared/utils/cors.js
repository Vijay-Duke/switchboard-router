/**
 * CORS preflight helper for gateway API routes.
 *
 * Switchboard is a gateway: browser-based clients (local dashboards, web
 * IDEs, hosted tools) call the compatibility APIs from arbitrary origins, so
 * the requesting Origin is reflected instead of maintaining an allowlist
 * (QA-023). Without Access-Control-Allow-Origin on the OPTIONS response the
 * browser blocks every cross-origin API call before it is ever issued.
 */

/**
 * Build an OPTIONS preflight response that reflects the requesting Origin.
 *
 * @param {Request|null} [request] - Incoming request (Origin is reflected when present).
 * @param {{ methods?: string }} [options] - Allowed methods list (defaults to "GET, POST, OPTIONS").
 * @returns {Response}
 */
export function corsPreflightResponse(request, options = {}) {
  const origin = request?.headers?.get?.("origin");
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Methods": options.methods || "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      // Reflected Origin must not be served interchangeably from shared caches.
      ...(origin ? { Vary: "Origin" } : {}),
    },
  });
}
