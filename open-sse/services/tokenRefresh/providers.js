import { PROVIDERS, PROVIDER_OAUTH } from "../../config/providers.js";
import { OAUTH_ENDPOINTS } from "../../config/appConstants.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { dedupRefresh } from "./dedup.js";
import { getOpenSseDeps } from "../../runtimeDeps.js";
import { isValidAwsRegion } from "../../utils/awsRegion.js";

/**
 * Classify a non-2xx OAuth token response. Permanent failures (revoked or
 * expired refresh token, e.g. `invalid_grant`) return the shared unrecoverable
 * shape so callers stop retrying and surface re-auth instead; transient
 * failures return null. Never logs raw bodies (may echo tokens).
 */
function unrecoverableRefreshResult(log, label, errorText, status) {
  const failure = classifyOAuthRefreshError(errorText, status);
  if (!failure.permanent) return null;
  log?.error?.("TOKEN_REFRESH", `${label} refresh token revoked or expired. Re-auth required.`, {
    status,
    code: failure.code,
  });
  return { error: "unrecoverable_refresh_error", code: failure.code };
}

/** M10: never log raw OAuth error bodies (may echo tokens). Keep status + error code only. */
function safeRefreshError(errorText = "", status = 0) {
  let code = "";
  try {
    const p = errorText ? JSON.parse(errorText) : null;
    code = p?.error || p?.error_code || p?.code || "";
  } catch { /* ignore */ }
  return { status, errorCode: code || undefined, bodyLen: errorText?.length || 0 };
}

let _xaiServiceSingleton = null;
export async function refreshXaiToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("xai", refreshToken, async () => {
    try {
      if (!_xaiServiceSingleton) {
        const factory = getOpenSseDeps().createXaiService;
        if (!factory) {
          log?.warn?.("TOKEN_REFRESH", "xAI service not wired (setOpenSseDeps)");
          return null;
        }
        _xaiServiceSingleton = await factory();
      }
      const tokens = await _xaiServiceSingleton.refreshAccessToken(refreshToken);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        idToken: tokens.id_token,
      };
    } catch (e) {
      const msg = String(e?.message || "");
      const errorCode = msg.includes("invalid_grant")
        ? "invalid_grant"
        : (msg.includes("invalid_request") ? "invalid_request" : null);
      log?.warn?.("TOKEN_REFRESH", "xai refresh failed", errorCode ? { errorCode } : undefined);
      if (errorCode) {
        return { error: errorCode };
      }
      return null;
    }
  }, log);
}

export async function refreshAccessToken(provider, refreshToken, credentials, log, proxyOptions = null) {
  const config = PROVIDERS[provider];
  const refreshUrl = config?.refreshUrl
    || PROVIDER_OAUTH[provider]?.refreshUrl
    || PROVIDER_OAUTH[provider]?.tokenUrl;

  if (!config || !refreshUrl) {
    log?.warn?.("TOKEN_REFRESH", `No refresh URL configured for provider: ${provider}`);
    return null;
  }

  if (!refreshToken) {
    log?.warn?.("TOKEN_REFRESH", `No refresh token available for provider: ${provider}`);
    return null;
  }

  return dedupRefresh(provider, refreshToken, async () => {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    });
    if (config.clientSecret) body.set("client_secret", config.clientSecret);
    const response = await proxyAwareFetch(refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      identity: config.identity,
      provider,
      format: config.format,
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      const unrecoverable = unrecoverableRefreshResult(log, provider, errorText, response.status);
      if (unrecoverable) return unrecoverable;
      log?.error?.("TOKEN_REFRESH", `Failed to refresh token for ${provider}`, {
        status: response.status,
        error: safeRefreshError(errorText, response.status),
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", `Successfully refreshed token for ${provider}`, {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Error refreshing token for ${provider}`, {
      error: error.message,
    });
    return null;
  }
  }, log);
}

// Cline / ClinePass: the extension JSON contract (not OAuth2 form). Shares the
// WorkOS refresh endpoint; the response wraps tokens in `data` with an
// ISO expiresAt (upstream 88676b30 / f6e7cabe).
export async function refreshClineToken(refreshToken, log, provider = "cline", proxyOptions = null) {
  if (!refreshToken) return null;
  const refreshUrl = PROVIDERS[provider]?.refreshUrl || PROVIDERS.cline?.refreshUrl;
  if (!refreshUrl) return null;

  return dedupRefresh(provider, refreshToken, async () => {
    try {
      const response = await proxyAwareFetch(refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" }),
        identity: PROVIDERS[provider]?.identity,
        provider,
        format: PROVIDERS[provider]?.format,
      }, proxyOptions);

      if (!response.ok) {
        const errorText = await response.text();
        const unrecoverable = unrecoverableRefreshResult(log, provider, errorText, response.status);
        if (unrecoverable) return unrecoverable;
        log?.error?.("TOKEN_REFRESH", `Failed to refresh ${provider} token`, {
          status: response.status,
          error: safeRefreshError(errorText, response.status),
        });
        return null;
      }

      const body = await response.json();
      const tokens = body?.data || body;
      if (!tokens?.accessToken) return null;
      const expiresAtMs = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : NaN;
      const expiresIn = Number.isFinite(expiresAtMs)
        ? Math.max(1, Math.floor((expiresAtMs - Date.now()) / 1000))
        : (tokens.expiresIn || tokens.expires_in || 3600);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || refreshToken,
        expiresIn,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Error refreshing ${provider} token: ${error.message}`);
      return null;
    }
  }, log);
}

export async function refreshClaudeOAuthToken(refreshToken, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh("claude", refreshToken, async () => {
  try {
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.anthropic.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: PROVIDERS.claude.clientId,
      }),
      identity: PROVIDERS.claude?.identity,
      provider: "claude",
      format: PROVIDERS.claude?.format,
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      const unrecoverable = unrecoverableRefreshResult(log, "Claude", errorText, response.status);
      if (unrecoverable) return unrecoverable;
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Claude OAuth token", { status: response.status, error: safeRefreshError(errorText, response.status) });
      return null;
    }

    const tokens = await response.json();
    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Claude OAuth token", { hasNewAccessToken: !!tokens.access_token, expiresIn: tokens.expires_in });
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Network error refreshing Claude token: ${error.message}`);
    return null;
  }
  }, log);
}

export async function refreshGoogleToken(refreshToken, clientId, clientSecret, log, provider = null, proxyOptions = null) {
  if (!refreshToken) return null;
  const resolvedProvider = provider
    || (clientId === PROVIDERS.antigravity?.clientId ? "antigravity" : "gemini-cli");
  const config = PROVIDERS[resolvedProvider];
  return dedupRefresh(`google:${clientId}`, refreshToken, async () => {
  try {
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      identity: config?.identity,
      provider: resolvedProvider,
      format: config?.format,
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      const unrecoverable = unrecoverableRefreshResult(log, "Google", errorText, response.status);
      if (unrecoverable) return unrecoverable;
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Google token", { status: response.status, error: safeRefreshError(errorText, response.status) });
      return null;
    }

    const tokens = await response.json();
    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Google token", { hasNewAccessToken: !!tokens.access_token, expiresIn: tokens.expires_in });
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Network error refreshing Google token: ${error.message}`);
    return null;
  }
  }, log);
}

export async function refreshQwenToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("qwen", refreshToken, async () => {
  const endpoint = OAUTH_ENDPOINTS.qwen.token;

  try {
    const response = await proxyAwareFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: PROVIDERS.qwen.clientId,
      }),
      identity: PROVIDERS.qwen?.identity,
      provider: "qwen",
      format: PROVIDERS.qwen?.format,
    });

    if (response.status === 200) {
      const tokens = await response.json();

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Qwen token", {
        hasNewAccessToken: !!tokens.access_token,
        hasNewRefreshToken: !!tokens.refresh_token,
        expiresIn: tokens.expires_in,
      });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        providerSpecificData: tokens.resource_url
          ? { resourceUrl: tokens.resource_url }
          : undefined,
      };
    } else {
      const errorText = await response.text().catch(() => "");
      const unrecoverable = unrecoverableRefreshResult(log, "Qwen", errorText, response.status);
      if (unrecoverable) return unrecoverable;
      log?.warn?.("TOKEN_REFRESH", `Error with Qwen endpoint`, {
        status: response.status,
        error: safeRefreshError(errorText, response.status),
      });
    }
  } catch (error) {
    log?.warn?.("TOKEN_REFRESH", `Network error trying Qwen endpoint`, {
      error: error.message,
    });
  }

  log?.error?.("TOKEN_REFRESH", "Failed to refresh Qwen token");
  return null;
  }, log);
}

export function classifyOAuthRefreshError(errorText = "", status = 0) {
  let parsed = null;
  try {
    parsed = errorText ? JSON.parse(errorText) : null;
  } catch {
    parsed = null;
  }

  // `error` is a string per RFC 6749; some providers nest an object instead.
  const err = parsed?.error;
  const code = (typeof err === "string" ? err : err?.code || err?.type) || parsed?.error_code || "";
  const description = parsed?.error_description || parsed?.message || err?.message || errorText || "";
  const combined = `${code} ${description}`.toLowerCase();
  // 5xx is never permanent whatever the body says: a false positive here
  // benches a healthy connection until the user reconnects.
  const permanent = status < 500 && [
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
    "invalid_grant",
    "bad_refresh_token", // GitHub
  ].some((marker) => combined.includes(marker));

  return { status, code, description, permanent };
}

export async function refreshCodexToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codex", refreshToken, async () => {
    try {
      const response = await proxyAwareFetch(OAUTH_ENDPOINTS.openai.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: PROVIDERS.codex.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        identity: PROVIDERS.codex?.identity,
        provider: "codex",
        format: PROVIDERS.codex?.format,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const failure = classifyOAuthRefreshError(errorText, response.status);
        if (failure.permanent) {
          log?.error?.("TOKEN_REFRESH", "Codex refresh token already used or invalid. Re-auth required.", {
            status: response.status,
            code: failure.code,
          });
          return { error: "unrecoverable_refresh_error", code: failure.code };
        }

        log?.error?.("TOKEN_REFRESH", "Failed to refresh Codex token", {
          status: response.status,
          error: safeRefreshError(errorText, response.status),
          code: failure.code,
          permanent: failure.permanent,
        });
        return null;
      }

      const tokens = await response.json();

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Codex token", {
        hasNewAccessToken: !!tokens.access_token,
        hasNewRefreshToken: !!tokens.refresh_token,
        hasIdToken: !!tokens.id_token,
        expiresIn: tokens.expires_in,
      });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Network error refreshing Codex token: ${error.message}`);
      return null;
    }
  }, log);
}

async function resolveKiroProfileArnPatch(providerSpecificData, accessToken, refreshedArn) {
  if (providerSpecificData?.profileArn) return {};
  let profileArn = refreshedArn?.trim?.() || null;
  if (!profileArn) {
    const fetchArn = getOpenSseDeps().fetchKiroProfileArn;
    if (fetchArn) profileArn = await fetchArn(accessToken, providerSpecificData?.region);
  }
  return profileArn ? { providerSpecificData: { profileArn } } : {};
}

export async function refreshKiroToken(refreshToken, providerSpecificData, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh("kiro", refreshToken, async () => {
  const authMethod = providerSpecificData?.authMethod;
  const clientId = providerSpecificData?.clientId;
  const clientSecret = providerSpecificData?.clientSecret;
  const region = providerSpecificData?.region;

  if (authMethod === "external_idp") {
    let refreshRequest;
    try {
      const buildParams = getOpenSseDeps().buildExternalIdpRefreshParams;
      if (!buildParams) throw new Error("buildExternalIdpRefreshParams not wired");
      refreshRequest = await buildParams(refreshToken, providerSpecificData);
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", `Invalid Kiro external_idp refresh config: ${error.message}`);
      return null;
    }

    const response = await proxyAwareFetch(refreshRequest.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: refreshRequest.body,
      identity: PROVIDERS.kiro?.identity,
      provider: "kiro",
      format: PROVIDERS.kiro?.format,
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro external_idp token", {
        status: response.status,
        error: safeRefreshError(errorText, response.status),
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro external_idp token", {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
      providerSpecificData: refreshRequest.providerSpecificData,
    };
  }

  if (clientId && clientSecret) {
    const isIDC = authMethod === "idc";
    const endpoint = isIDC && isValidAwsRegion(region)
      ? `https://oidc.${region}.amazonaws.com/token`
      : "https://oidc.us-east-1.amazonaws.com/token";

    const response = await proxyAwareFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        grantType: "refresh_token",
      }),
      identity: PROVIDERS.kiro?.identity,
      provider: "kiro",
      format: PROVIDERS.kiro?.format,
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro AWS token", {
        status: response.status,
        error: safeRefreshError(errorText, response.status),
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro AWS token", {
      hasNewAccessToken: !!tokens.accessToken,
      expiresIn: tokens.expiresIn,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || refreshToken,
      expiresIn: tokens.expiresIn,
      ...(await resolveKiroProfileArnPatch(providerSpecificData, tokens.accessToken, tokens.profileArn)),
    };
  }

  const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "kiro-cli/1.0.0",
    },
    body: JSON.stringify({
      refreshToken: refreshToken,
    }),
    identity: PROVIDERS.kiro?.identity,
    provider: "kiro",
    format: PROVIDERS.kiro?.format,
  }, proxyOptions);

  if (!response.ok) {
    const errorText = await response.text();
    log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro social token", {
      status: response.status,
      error: safeRefreshError(errorText, response.status),
    });
    return null;
  }

  const tokens = await response.json();

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro social token", {
    hasNewAccessToken: !!tokens.accessToken,
    expiresIn: tokens.expiresIn,
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || refreshToken,
    expiresIn: tokens.expiresIn,
    ...(await resolveKiroProfileArnPatch(providerSpecificData, tokens.accessToken, tokens.profileArn)),
  };
  }, log);
}

export async function refreshIflowToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("iflow", refreshToken, async () => {
  const basicAuth = btoa(`${PROVIDERS.iflow.clientId}:${PROVIDERS.iflow.clientSecret}`);

  const response = await proxyAwareFetch(OAUTH_ENDPOINTS.iflow.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: PROVIDERS.iflow.clientId,
      client_secret: PROVIDERS.iflow.clientSecret,
    }),
    identity: PROVIDERS.iflow?.identity,
    provider: "iflow",
    format: PROVIDERS.iflow?.format,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const unrecoverable = unrecoverableRefreshResult(log, "iFlow", errorText, response.status);
    if (unrecoverable) return unrecoverable;
    log?.error?.("TOKEN_REFRESH", "Failed to refresh iFlow token", {
      status: response.status,
      error: safeRefreshError(errorText, response.status),
    });
    return null;
  }

  const tokens = await response.json();

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed iFlow token", {
    hasNewAccessToken: !!tokens.access_token,
    hasNewRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresIn: tokens.expires_in,
  };
  }, log);
}

export async function refreshGitHubToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("github", refreshToken, async () => {
  const params = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: PROVIDERS.github.clientId,
  };
  if (PROVIDERS.github.clientSecret) {
    params.client_secret = PROVIDERS.github.clientSecret;
  }

  const response = await proxyAwareFetch(OAUTH_ENDPOINTS.github.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
    identity: PROVIDERS.github?.identity,
    provider: "github",
    format: PROVIDERS.github?.format,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const unrecoverable = unrecoverableRefreshResult(log, "GitHub", errorText, response.status);
    if (unrecoverable) return unrecoverable;
    log?.error?.("TOKEN_REFRESH", "Failed to refresh GitHub token", {
      status: response.status,
      error: safeRefreshError(errorText, response.status),
    });
    return null;
  }

  const tokens = await response.json();
  // GitHub answers a bad/expired refresh token with HTTP 200 + an OAuth error body.
  if (tokens.error || !tokens.access_token) {
    const errorText = JSON.stringify(tokens);
    const unrecoverable = unrecoverableRefreshResult(log, "GitHub", errorText, response.status);
    if (unrecoverable) return unrecoverable;
    log?.error?.("TOKEN_REFRESH", "Failed to refresh GitHub token", {
      status: response.status,
      error: safeRefreshError(errorText, response.status),
    });
    return null;
  }

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed GitHub token", {
    hasNewAccessToken: !!tokens.access_token,
    hasNewRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresIn: tokens.expires_in,
  };
  }, log);
}

export async function refreshCopilotToken(githubAccessToken, log) {
  if (!githubAccessToken) return null;
  return dedupRefresh("copilot", githubAccessToken, async () => {
  try {
    const response = await proxyAwareFetch(PROVIDER_OAUTH["github"]?.copilotTokenUrl, {
      headers: {
        "Authorization": `token ${githubAccessToken}`,
        "Accept": "application/json",
      },
      identity: PROVIDERS.github?.identity,
      provider: "github",
      format: PROVIDERS.github?.format,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Copilot token", {
        status: response.status,
        error: safeRefreshError(errorText, response.status)
      });
      return null;
    }

    const data = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Copilot token", {
      hasToken: !!data.token,
      expiresAt: data.expires_at
    });

    return {
      token: data.token,
      expiresAt: data.expires_at
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", "Error refreshing Copilot token", {
      error: error.message
    });
    return null;
  }
  }, log);
}

// CodeBuddy (Tencent) refresh — POST /v2/plugin/auth/token/refresh with the
// refresh token carried in the X-Refresh-Token header (not a form body),
// matching the official CodeBuddy CLI. Response: { code: 0, data: <token> }.
export async function refreshCodebuddyToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codebuddy-cn", refreshToken, async () => {
    const oauth = PROVIDER_OAUTH["codebuddy-cn"] || {};
    const response = await proxyAwareFetch(oauth.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": oauth.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "copilot.tencent.com",
        "X-Refresh-Token": refreshToken,
      },
      body: JSON.stringify({ refreshToken }),
      identity: PROVIDERS["codebuddy-cn"]?.identity,
      provider: "codebuddy-cn",
      format: PROVIDERS["codebuddy-cn"]?.format,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy token", {
        status: response.status,
        error: safeRefreshError(errorText, response.status),
      });
      return null;
    }

    const data = await response.json();
    if (data.code !== 0 || !data.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "CodeBuddy token refresh returned no token", {
        code: data.code,
        msg: data.msg,
      });
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy token", {
      hasNewAccessToken: !!data.data.accessToken,
      hasNewRefreshToken: !!data.data.refreshToken,
      expiresIn: data.data.expiresIn,
    });

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken || refreshToken,
      expiresIn: data.data.expiresIn,
    };
  }, log);
}

// ── Nous Research Portal (hermes-cli) ────────────────────────────────────────
// Flow: refresh_token → new access_token → mint fresh agent_key.
export async function refreshNousToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("nous", refreshToken, async () => {
    try {
      const oauth = PROVIDER_OAUTH["nous"] || {};
      const tokenResponse = await proxyAwareFetch(oauth.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "x-nous-refresh-token": refreshToken,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: oauth.clientId,
        }),
        provider: "nous", identity: PROVIDERS.nous.identity, format: PROVIDERS.nous.format, redirect: "error",
        signal: AbortSignal.timeout(30000),
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text().catch(() => "");
        log?.error?.("TOKEN_REFRESH", "Failed to refresh Nous token", {
          status: tokenResponse.status,
          error: safeRefreshError(error, tokenResponse.status),
        });
        return null;
      }

      const tokenData = await tokenResponse.json();
      if (!tokenData?.access_token) {
        log?.error?.("TOKEN_REFRESH", "Nous token refresh returned no access_token");
        return null;
      }

      let agentKey = null;
      let agentKeyId = null;
      let agentKeyExpiresAt = null;
      try {
        const agentKeyResponse = await proxyAwareFetch(oauth.agentKeyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${tokenData.access_token}`,
          },
          body: JSON.stringify({
            min_ttl_seconds: 7200,
          }),
          provider: "nous", identity: PROVIDERS.nous.identity, format: PROVIDERS.nous.format, redirect: "error",
          signal: AbortSignal.timeout(15000),
        });

        if (agentKeyResponse.ok) {
          const agentKeyData = await agentKeyResponse.json();
          agentKey = agentKeyData.api_key || null;
          agentKeyId = agentKeyData.key_id || null;
          agentKeyExpiresAt = agentKeyData.expires_at || null;
          log?.info?.("TOKEN_REFRESH", "Nous agent key minted successfully");
        } else {
          const error = await agentKeyResponse.text().catch(() => "");
          log?.warn?.("TOKEN_REFRESH", "Failed to mint Nous agent key, falling back to access_token", { error });
        }
      } catch (mintErr) {
        log?.warn?.("TOKEN_REFRESH", `Nous agent key mint error: ${mintErr?.message || mintErr}`);
      }

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshToken,
        expiresIn: tokenData.expires_in,
        apiKey: agentKey || tokenData.access_token,
        agentKey,
        providerSpecificData: {
          ...(agentKeyId ? { agentKeyId } : {}),
          ...(agentKeyExpiresAt ? { agentKeyExpiresAt } : {}),
        },
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Error refreshing Nous token: ${error.message}`);
      return null;
    }
  }, log);
}

// ── MiniMax Code (mcode) ─────────────────────────────────────────────────────
// MiniMax refresh tokens are SINGLE-USE: sending the same one twice answers
// invalid_grant (HTTP 400) and signs the account out. Two paths reach refresh
// (background scheduler + executor's on-401 retry) and may hold different
// snapshots of one connection, so dedupRefresh keys on the spent token value —
// a token already sent resolves to the cached result instead of a second send.
// An invalid_grant is the ONLY answer that means the sign-in is gone; anything
// else (5xx, timeout) returns null and the current access token stays usable.
const MINIMAX_CODE_SITES = {
  "minimax-code": "https://account.minimax.cn/oauth2/token",
  "minimax-code-global": "https://account.minimax.io/oauth2/token",
};

export async function refreshMiniMaxCodeToken(provider, refreshToken, log) {
  const tokenUrl = MINIMAX_CODE_SITES[provider];
  if (!tokenUrl || !refreshToken) return null;
  return dedupRefresh(provider, refreshToken, async () => {
    try {
      const response = await proxyAwareFetch(tokenUrl, {
        identity: PROVIDERS[provider]?.identity, provider, format: PROVIDERS[provider]?.format, redirect: "error",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: "mcode-public",
          scope: "agent.default",
          audience: "agent-backend",
        }).toString(),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || (data && typeof data.error === "string" && data.error)) {
        const code = data?.error || `HTTP ${response.status}`;
        if (response.status === 400 && data?.error === "invalid_grant") {
          log?.warn?.("TOKEN_REFRESH", `MiniMax refresh token spent/rejected (${provider}) — sign-in gone`);
          return { error: "invalid_grant" };
        }
        log?.error?.("TOKEN_REFRESH", `MiniMax token refresh failed (${provider})`, { status: response.status, error: code });
        return null;
      }
      if (!data?.access_token) {
        log?.error?.("TOKEN_REFRESH", `MiniMax refresh returned no access_token (${provider})`);
        return null;
      }
      return {
        accessToken: data.access_token,
        // MiniMax rotates the refresh token on every refresh; keep the old one
        // only if the answer oddly omits it.
        refreshToken: data.refresh_token || refreshToken,
        expiresIn: data.expires_in,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Error refreshing MiniMax token (${provider}): ${error.message}`);
      return null;
    }
  }, log);
}

// Zed auth is a long-lived RSA-decrypted access_token with no OAuth2 refresh
// grant (the keypair lives with the client); refresh is a re-login.
export function refreshZedToken() {
  return null;
}
