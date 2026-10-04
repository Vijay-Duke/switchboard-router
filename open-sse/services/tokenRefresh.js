import { PROVIDERS } from "../config/providers.js";
import { OAUTH_ENDPOINTS, REFRESH_LEAD_MS } from "../config/appConstants.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  refreshXaiToken,
  refreshAccessToken,
  refreshClaudeOAuthToken,
  refreshGoogleToken,
  refreshQwenToken,
  refreshCodexToken,
  refreshKiroToken,
  refreshIflowToken,
  refreshGitHubToken,
  refreshCopilotToken,
  refreshCodebuddyToken,
  classifyOAuthRefreshError,
} from "./tokenRefresh/providers.js";

// Re-export all provider refresh functions (preserves public API for all consumers)
export {
  refreshAccessToken,
  refreshClaudeOAuthToken,
  refreshGoogleToken,
  refreshQwenToken,
  refreshCodexToken,
  refreshKiroToken,
  refreshIflowToken,
  refreshGitHubToken,
  refreshCopilotToken,
  refreshCodebuddyToken,
  classifyOAuthRefreshError,
};

export const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function isUnrecoverableRefreshError(result) {
  return (
    result &&
    typeof result === "object" &&
    (result.error === "unrecoverable_refresh_error" ||
      result.error === "refresh_token_reused" ||
      result.error === "invalid_request" ||
      result.error === "invalid_grant")
  );
}

export function getRefreshLeadMs(provider) {
  return REFRESH_LEAD_MS[provider] || TOKEN_EXPIRY_BUFFER_MS;
}

export function parseVertexSaJson(apiKey) {
  if (typeof apiKey !== "string") return null;
  try {
    const parsed = JSON.parse(apiKey);
    if (parsed.type === "service_account" && parsed.client_email && parsed.private_key && parsed.project_id) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Cache Vertex tokens keyed by service account email { token, expiresAt }
const vertexTokenCache = new Map();

export async function refreshVertexToken(saJson, log, provider = "vertex", proxyOptions = null) {
  const cacheKey = saJson.client_email;
  const cached = vertexTokenCache.get(cacheKey);

  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return { accessToken: cached.token, expiresAt: cached.expiresAt };
  }

  try {
    const { SignJWT, importPKCS8 } = await import("jose");
    log?.debug?.("TOKEN_REFRESH", `Vertex minting token for ${saJson.client_email}`);
    const privateKey = await importPKCS8(saJson.private_key.replace(/\\n/g, "\n"), "RS256");
    const now = Math.floor(Date.now() / 1000);

    const jwt = await new SignJWT({ scope: "https://www.googleapis.com/auth/cloud-platform" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(saJson.client_email)
      .setAudience(OAUTH_ENDPOINTS.google.token)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const config = PROVIDERS[provider] || PROVIDERS.vertex;
    const res = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
      identity: config.identity,
      provider,
      format: config.format,
    }, proxyOptions);

    if (!res.ok) {
      const err = await res.text();
      log?.error?.("TOKEN_REFRESH", `Vertex token mint failed: ${err}`);
      return null;
    }

    const { access_token, expires_in } = await res.json();
    const expiresAt = Date.now() + (expires_in ?? 3600) * 1000;

    vertexTokenCache.set(cacheKey, { token: access_token, expiresAt });
    log?.info?.("TOKEN_REFRESH", `Vertex token minted for ${saJson.client_email}`);

    return { accessToken: access_token, expiresAt };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Vertex token error: ${error.message}`);
    return null;
  }
}

function vertexRefreshHandler(c, log, provider = "vertex") {
  const saJson = parseVertexSaJson(c.apiKey);
  if (saJson) return refreshVertexToken(saJson, log, provider);
  // ADC authorized_user in apiKey (wave13) — no OAuth refreshToken field
  try {
    const parsed = typeof c.apiKey === "string" ? JSON.parse(c.apiKey) : null;
    if (
      parsed?.type === "authorized_user" &&
      parsed.refresh_token &&
      parsed.client_id &&
      parsed.client_secret
    ) {
      return refreshGoogleToken(
        parsed.refresh_token,
        parsed.client_id,
        parsed.client_secret,
        log,
        provider,
      );
    }
  } catch {
    /* not JSON */
  }
  return null;
}

const REFRESH_HANDLERS = {
  "gemini-cli": (c, log) => refreshGoogleToken(c.refreshToken, PROVIDERS["gemini-cli"].clientId, PROVIDERS["gemini-cli"].clientSecret, log),
  antigravity: (c, log) => refreshGoogleToken(c.refreshToken, PROVIDERS.antigravity.clientId, PROVIDERS.antigravity.clientSecret, log),
  claude: (c, log) => refreshClaudeOAuthToken(c.refreshToken, log),
  codex: (c, log) => refreshCodexToken(c.refreshToken, log),
  qwen: (c, log) => refreshQwenToken(c.refreshToken, log),
  iflow: (c, log) => refreshIflowToken(c.refreshToken, log),
  github: (c, log) => refreshGitHubToken(c.refreshToken, log),
  kiro: (c, log) => refreshKiroToken(c.refreshToken, c.providerSpecificData, log),
  xai: (c, log) => refreshXaiToken(c.refreshToken, log),
  "grok-cli": (c, log, proxyOptions) => refreshAccessToken("grok-cli", c.refreshToken, c, log, proxyOptions),
  "codebuddy-cn": (c, log) => refreshCodebuddyToken(c.refreshToken, log),
  muse: (c, log) => refreshMuseToken(c.providerSpecificData?.dcaToken || c.refreshToken, log),
  vertex: (c, log) => vertexRefreshHandler(c, log, "vertex"),
  "vertex-partner": (c, log) => vertexRefreshHandler(c, log, "vertex-partner"),
};

async function refreshMuseToken(dcaToken, log) {
  if (!dcaToken) return null;
  try {
    const mintUrl = process.env.META_MINT_URL || "https://api.meta.ai/muse-code/key";
    const res = await proxyAwareFetch(mintUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dcaToken}`,
        "User-Agent": "muse-code/1.0.2",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ dca_token: dcaToken }),
      identity: "muse-code",
      provider: "muse",
    });
    if (!res.ok) {
      log?.warn?.("TOKEN_REFRESH", `Failed to re-mint Meta Muse API key: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return {
      accessToken: data.api_key,
      apiKey: data.api_key,
      providerSpecificData: {
        apiKey: data.api_key,
        baseUrl: data.base_url || "https://api.meta.ai/v1",
      },
    };
  } catch (err) {
    log?.warn?.("TOKEN_REFRESH", `Error re-minting Meta Muse API key: ${err?.message}`);
    return null;
  }
}

export async function getAccessToken(provider, credentials, log) {
  // Vertex SA / ADC mint from apiKey JSON — no OAuth refreshToken (wave12/13)
  const vertexLike = provider === "vertex" || provider === "vertex-partner";
  if (vertexLike && credentials?.apiKey) {
    return _getAccessTokenInternal(provider, credentials, log);
  }
  if (!credentials || !credentials.refreshToken || typeof credentials.refreshToken !== "string") {
    log?.warn?.("TOKEN_REFRESH", `No valid refresh token available for provider: ${provider}`);
    return null;
  }
  return _getAccessTokenInternal(provider, credentials, log);
}

async function _getAccessTokenInternal(provider, credentials, log) {
  if (provider === "gemini") {
    return refreshGoogleToken(credentials.refreshToken, PROVIDERS.gemini.clientId, PROVIDERS.gemini.clientSecret, log);
  }
  const handler = REFRESH_HANDLERS[provider];
  if (!handler) {
    log?.warn?.("TOKEN_REFRESH", `Unsupported provider for token refresh: ${provider}`);
    return null;
  }
  return handler(credentials, log);
}

export async function refreshTokenByProvider(provider, credentials, log, proxyOptions = null) {
  // Vertex SA/ADC use apiKey JSON, not refreshToken (wave12)
  const vertexLike = provider === "vertex" || provider === "vertex-partner";
  if (!credentials.refreshToken && !(vertexLike && credentials?.apiKey)) return null;
  const handler = REFRESH_HANDLERS[provider];
  return handler
    ? handler(credentials, log, proxyOptions)
    : refreshAccessToken(provider, credentials.refreshToken, credentials, log, proxyOptions);
}

export function formatProviderCredentials(provider, credentials, log) {
  const config = PROVIDERS[provider];
  if (!config) {
    log?.warn?.("TOKEN_REFRESH", `No configuration found for provider: ${provider}`);
    return null;
  }

  switch (provider) {
    case "gemini":
      return {
        apiKey: credentials.apiKey,
        accessToken: credentials.accessToken,
        projectId: credentials.projectId
      };

    case "claude":
      return {
        apiKey: credentials.apiKey,
        accessToken: credentials.accessToken
      };

    case "codex":
    case "qwen":
    case "iflow":
    case "openai":
    case "openrouter":
    case "xai":
    case "grok-cli":
    case "muse":
      return {
        apiKey: credentials.apiKey || credentials.accessToken,
        accessToken: credentials.accessToken || credentials.apiKey
      };

    case "antigravity":
    case "gemini-cli":
      return {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        projectId: credentials.projectId
      };

    default:
      return {
        apiKey: credentials.apiKey,
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken
      };
  }
}

export async function getAllAccessTokens(userInfo, log) {
  const results = {};

  if (userInfo.connections && Array.isArray(userInfo.connections)) {
    for (const connection of userInfo.connections) {
      if (connection.isActive && connection.provider) {
        const token = await getAccessToken(connection.provider, {
          refreshToken: connection.refreshToken
        }, log);

        if (token) {
          results[connection.provider] = token;
        }
      }
    }
  }

  return results;
}

export async function refreshWithRetry(refreshFn, maxRetries = 3, log = null) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 1000;
      log?.debug?.("TOKEN_REFRESH", `Retry ${attempt}/${maxRetries} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const result = await refreshFn();
      // Permanent failure (revoked refresh token) is final: return at once
      // instead of burning further attempts + backoff sleeps on a dead
      // credential. The marker flows to re-auth handling downstream.
      if (isUnrecoverableRefreshError(result)) return result;
      if (result) return result;
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", `Attempt ${attempt + 1}/${maxRetries} failed: ${error.message}`);
    }
  }

  log?.error?.("TOKEN_REFRESH", `All ${maxRetries} retry attempts failed`);
  return null;
}
