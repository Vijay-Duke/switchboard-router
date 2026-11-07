// Upstream response headers a client needs to back off correctly: Anthropic's
// rate-limit window headers plus the generic retry signals. Everything else
// (cookies, request ids, CORS) stays on the upstream hop.
const FORWARDED = new Set(["retry-after", "x-should-retry"]);
const FORWARDED_PREFIX = "anthropic-ratelimit-";

export function upstreamResponseHeaders(headers) {
  const out = {};
  if (typeof headers?.forEach !== "function") return out;
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (FORWARDED.has(key) || key.startsWith(FORWARDED_PREFIX)) out[key] = value;
  });
  return out;
}
