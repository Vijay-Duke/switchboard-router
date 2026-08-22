import { wrapHeaders } from "../identity/wrap.js";

export function getClineAccessToken(token) {
  if (typeof token !== "string") return "";
  const trimmed = token.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("workos:") ? trimmed : `workos:${trimmed}`;
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
