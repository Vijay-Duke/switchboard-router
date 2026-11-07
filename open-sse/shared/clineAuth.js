import { wrapHeaders } from "../identity/wrap.js";

export function getClineAccessToken(token) {
  if (typeof token !== "string") return "";
  const trimmed = token.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase().startsWith("workos:")) return trimmed;
  // Cline OAuth access tokens are WorkOS JWTs (base64url `eyJ…` header) and
  // need the `workos:` prefix. ClinePass API keys (e.g. `clp_…`) are opaque and
  // must be sent verbatim — prefixing them makes api.cline.bot answer 401.
  const isWorkOsJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(trimmed);
  return isWorkOsJwt ? `workos:${trimmed}` : trimmed;
}

export function getClineAuthorizationHeader(token) {
  const accessToken = getClineAccessToken(token);
  return accessToken ? `Bearer ${accessToken}` : "";
}

export function buildClineHeaders(token, extraHeaders = {}) {
  const authorization = getClineAuthorizationHeader(token);
  const { headers } = wrapHeaders({
    ...(authorization ? { Authorization: authorization } : {}),
    ...extraHeaders,
  }, { identity: "cline" });
  return headers;
}
