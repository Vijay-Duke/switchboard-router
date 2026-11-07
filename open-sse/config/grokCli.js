// cli-chat-proxy rejects older identities with HTTP 426. Keep this on a
// current @xai-official/grok release (1.0.44 as of 2026-10-01; minimum 1.0.13).
export const GROK_CLI_VERSION = "1.0.44";
export const GROK_CLI_MODEL = "grok-build";
export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_IDENTITY = "grok-build";
export const GROK_CLI_FETCH_PROFILE = Object.freeze({
  identity: GROK_CLI_IDENTITY,
  provider: "grok-cli",
  format: "openai-responses",
});

export function supportsGrokCliReasoningEffort(model) {
  return /^grok-4\.5(?:$|-)/.test(String(model || ""));
}

export function buildGrokCliApiHeaders(accessToken, providerSpecificData = {}) {
  const headers = {
    Accept: "application/json",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "headless",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const email = providerSpecificData.email;
  const userId = providerSpecificData.userId || providerSpecificData.principalId;
  if (email) headers["x-email"] = email;
  if (userId) headers["x-userid"] = userId;
  return headers;
}
