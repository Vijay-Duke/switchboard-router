/**
 * Selects the real Claude Code client identity/capability headers from a
 * request, for forwarding to api.anthropic.com in place of static hardcoded
 * values. Request-scoped only: no cross-request state is kept.
 */

const CLAUDE_IDENTITY_HEADERS = [
  "user-agent",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "x-app",
  "x-stainless-helper-method",
  "x-stainless-retry-count",
  "x-stainless-runtime-version",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-lang",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-timeout",
  "x-claude-code-session-id",
  "package-version",
  "runtime-version",
  "os",
  "arch",
];

/**
 * Select only non-secret Claude Code identity/capability headers.
 * @param {object} headers
 * @returns {object|null}
 */
export function pickClaudeIdentityHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const captured = {};
  for (const key of CLAUDE_IDENTITY_HEADERS) {
    if (headers[key] !== undefined && headers[key] !== null) captured[key] = headers[key];
  }
  return Object.keys(captured).length > 0 ? captured : null;
}
