import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import {
  GROK_CLI_BASE_URL,
  GROK_CLI_FETCH_PROFILE,
  buildGrokCliApiHeaders,
} from "open-sse/config/grokCli.js";
import { decodeXaiIdTokenEmail, extractEmailFromAccessToken } from "./providerHelpers";

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: "invalid_response", error_description: text }; }
}

export async function requestGrokCliDeviceCode(config) {
  const body = new URLSearchParams({ client_id: config.clientId, scope: config.scope });
  if (config.referrer) body.set("referrer", config.referrer);
  const response = await proxyAwareFetch(config.deviceCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    ...GROK_CLI_FETCH_PROFILE,
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(`Grok CLI device code request failed: ${data.error_description || data.error || response.status}`);
  return data;
}

export async function pollGrokCliToken(config, deviceCode) {
  const response = await proxyAwareFetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: config.clientId,
    }),
    ...GROK_CLI_FETCH_PROFILE,
  });
  const data = await readJson(response);
  const pending = data.error === "authorization_pending" || data.error === "slow_down";
  return { ok: response.ok || pending, data };
}

export async function fetchGrokCliUser(tokens) {
  try {
    const response = await proxyAwareFetch(`${GROK_CLI_BASE_URL}/user`, {
      headers: buildGrokCliApiHeaders(tokens.access_token),
      ...GROK_CLI_FETCH_PROFILE,
    });
    return { user: response.ok ? await response.json() : null };
  } catch {
    return { user: null };
  }
}

export function mapGrokCliTokens(tokens, extra = null) {
  const user = extra?.user || {};
  const email = decodeXaiIdTokenEmail(tokens.id_token)
    || extractEmailFromAccessToken(tokens.access_token)
    || user.email;
  const userId = user.userId || user.principalId || null;
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    providerSpecificData: {
      authMethod: "device_code",
      idToken: tokens.id_token || null,
      email: email || null,
      userId,
      hasGrokCodeAccess: user.hasGrokCodeAccess ?? null,
      subscriptionTier: user.subscriptionTier ?? null,
    },
  };
}
