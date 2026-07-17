import { KIRO_CONFIG, assertValidAwsRegion } from "../constants/oauth.js";

/**
 * Kiro OAuth Service
 * Supports multiple authentication methods:
 * 1. AWS Builder ID (Device Code Flow)
 * 2. AWS IAM Identity Center/IDC (Device Code Flow)
 * 3. Google/GitHub Social Login (Authorization Code Flow + Manual Callback)
 * 4. Import Token (Manual refresh token paste)
 */

const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";

/**
 * Build a tagged validation error. The `code` lets the API route map a failure
 * to a precise HTTP status + user-facing reason without parsing message text.
 * @param {string} message safe, user-facing message (never an upstream body)
 * @param {"MISSING_KEY"|"REGION_UNAVAILABLE"|"NETWORK_ERROR"|"AUTH_REJECTED"|"VALIDATION_FAILED"} code
 * @returns {Error & { code: string }}
 */
function makeApiKeyError(message, code) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

export class KiroService {
  /**
   * Register OIDC client with AWS SSO
   * Returns clientId and clientSecret for device code flow
   */
  async registerClient(region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/client/register`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientName: KIRO_CONFIG.clientName,
        clientType: KIRO_CONFIG.clientType,
        scopes: KIRO_CONFIG.scopes,
        grantTypes: KIRO_CONFIG.grantTypes,
        issuerUrl: KIRO_CONFIG.issuerUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register client: ${error}`);
    }

    const data = await response.json();
    return {
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      clientSecretExpiresAt: data.clientSecretExpiresAt,
    };
  }

  /**
   * Start device authorization for AWS Builder ID or IDC
   */
  async startDeviceAuthorization(clientId, clientSecret, startUrl, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/device_authorization`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to start device authorization: ${error}`);
    }

    const data = await response.json();
    return {
      deviceCode: data.deviceCode,
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      expiresIn: data.expiresIn,
      interval: data.interval || 5,
    };
  }

  /**
   * Poll for token using device code (AWS Builder ID/IDC)
   */
  async pollDeviceToken(clientId, clientSecret, deviceCode, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await response.json();

    // Handle pending/slow_down/errors
    if (!response.ok || data.error) {
      return {
        success: false,
        error: data.error,
        errorDescription: data.error_description,
        pending: data.error === "authorization_pending" || data.error === "slow_down",
      };
    }

    return {
      success: true,
      tokens: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        tokenType: data.tokenType,
      },
    };
  }

  /**
   * Build Google/GitHub social login URL
   * Returns authorization URL for manual callback flow
   * Uses kiro:// custom protocol as required by AWS Cognito whitelist
   */
  buildSocialLoginUrl(provider, codeChallenge, state) {
    const idp = provider === "google" ? "Google" : "Github";
    // AWS Cognito only whitelists kiro:// protocol, not localhost
    const redirectUri = "kiro://kiro.kiroAgent/authenticate-success";
    return `${KIRO_AUTH_SERVICE}/login?idp=${idp}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}&prompt=select_account`;
  }

  /**
   * Exchange authorization code for tokens (Social Login)
   * Must use same redirect_uri as authorization request
   */
  async exchangeSocialCode(code, codeVerifier) {
    // Must match the redirect_uri used in buildSocialLoginUrl
    const redirectUri = "kiro://kiro.kiroAgent/authenticate-success";

    const response = await fetch(`${KIRO_AUTH_SERVICE}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  /**
   * Refresh token using refresh token
   */
  async refreshToken(refreshToken, providerSpecificData = {}) {
    const { authMethod, clientId, clientSecret, region } = providerSpecificData;

    // AWS SSO OIDC refresh (Builder ID or IDC)
    if (clientId && clientSecret) {
      const safeRegion = region || "us-east-1";
      assertValidAwsRegion(safeRegion);
      const endpoint = `https://oidc.${safeRegion}.amazonaws.com/token`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          refreshToken,
          grantType: "refresh_token",
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
      }

      const data = await response.json();
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
        profileArn: data.profileArn,
        expiresIn: data.expiresIn,
      };
    }

    // Social auth refresh (Google/GitHub)
    const response = await fetch(`${KIRO_AUTH_SERVICE}/refreshToken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  /**
   * Validate and import refresh token
   */
  async validateImportToken(refreshToken) {
    // Validate token format
    if (!refreshToken.startsWith("aorAAAAAG")) {
      throw new Error("Invalid token format. Token should start with aorAAAAAG...");
    }

    // Try to refresh to validate
    try {
      const result = await this.refreshToken(refreshToken);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || refreshToken,
        profileArn: result.profileArn,
        expiresIn: result.expiresIn,
        authMethod: "imported",
      };
    } catch (error) {
      throw new Error(`Token validation failed: ${error.message}`);
    }
  }

  /**
   * List available CodeWhisperer profiles for a token (or API key) and return
   * the best-matching profileArn. AWS SSO OIDC logins return no profileArn, so
   * it must be fetched separately — the same call works for API-key auth.
   * Accepts both `arn` and `profileArn` response field names (the API-key
   * JSON-1.0 surface returns `arn`).
   */
  async listAvailableProfiles(accessToken, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://codewhisperer.${region}.amazonaws.com`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      body: JSON.stringify({ maxResults: 10 }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list profiles: ${error}`);
    }

    const data = await response.json();
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const arnOf = (p) => p?.arn || p?.profileArn || null;
    const match = profiles.find((p) => arnOf(p)?.split(":")[3] === region) || profiles[0];
    return arnOf(match);
  }

  /**
   * Verify that an API key actually authenticates against CodeWhisperer.
   *
   * We deliberately DO NOT use ListAvailableProfiles here: with no `tokentype`
   * header it returns HTTP 200 + an empty profile list for *any* string (so a
   * bogus key looks valid — a false positive), and with `tokentype: API_KEY` it
   * returns 403 "API key authentication is not supported for this operation" for
   * *every* key (a false negative). ListAvailableModels, by contrast, accepts
   * API-key auth and genuinely validates the bearer: a working key returns 2xx,
   * a rejected key returns 401/403 "The bearer token included in the request is
   * invalid." That is the signal we want.
   *
   * Throws a tagged Error (`.code`) so the caller can map it to a clear,
   * region-aware HTTP response. Never reflects the upstream response body to the
   * client (SSRF hardening, GHSA-6mwv-4mrm-5p3m) — only a curated message.
   *
   * @param {string} apiKey trimmed bearer credential
   * @param {string} region AWS region for the CodeWhisperer service endpoint
   * @returns {Promise<true>} resolves when the key authenticates
   */
  async verifyApiKey(apiKey, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://codewhisperer.${region}.amazonaws.com`;

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererService.ListAvailableModels",
          "Authorization": `Bearer ${apiKey}`,
          // Marks the bearer as a long-lived API key rather than an OIDC/social
          // access token — CodeWhisperer requires this to accept API-key auth.
          "tokentype": "API_KEY",
          "Accept": "application/json",
        },
        body: JSON.stringify({ origin: "AI_EDITOR" }),
      });
    } catch (err) {
      // Most commonly a region with no CodeWhisperer endpoint. Amazon
      // Q/CodeWhisperer only resolves in us-east-1 today, so a non-default
      // region here is a DNS (ENOTFOUND) failure, not a bad key.
      const code = err?.cause?.code || err?.code;
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        throw makeApiKeyError(
          `Could not reach CodeWhisperer in region "${region}". Amazon Q/CodeWhisperer is only reachable in us-east-1 — set the AWS Region to us-east-1 and try again.`,
          "REGION_UNAVAILABLE"
        );
      }
      throw makeApiKeyError(
        `Network error contacting CodeWhisperer (${code || "connection failed"}). Check your connection and try again.`,
        "NETWORK_ERROR"
      );
    }

    // 2xx: authenticated. 400: the bearer was accepted and we only tripped an
    // argument check (our well-formed body reaches auth first — a *rejected*
    // key returns 401/403, never 400 — so 400 still means the key is valid).
    if (response.ok || response.status === 400) return true;

    if (response.status === 401 || response.status === 403) {
      throw makeApiKeyError(
        "AWS rejected the API key — it is invalid, expired, or not permitted for CodeWhisperer. Note: long-lived Kiro API-key auth for chat is currently limited upstream (kirodotdev/Kiro#7508); if the key is correct, try Builder ID, social login, or Import Token instead.",
        "AUTH_REJECTED"
      );
    }

    throw makeApiKeyError(
      `CodeWhisperer returned HTTP ${response.status} while validating the key. Try again shortly.`,
      "VALIDATION_FAILED"
    );
  }

  /**
   * Validate an API-key credential and return a credential object ready to
   * persist as a "kiro" connection with authMethod="api_key". API keys are
   * long-lived bearer tokens (no refresh), so validation makes a real
   * authenticated CodeWhisperer call (see verifyApiKey). A connection is only
   * ever saved when this resolves, so a key that cannot authenticate is never
   * stored as "active".
   *
   * profileArn is intentionally left null: API-key connections carry no
   * account-bound profile (ListAvailableProfiles rejects API-key auth), and the
   * request translator sends an empty profileArn so CodeWhisperer uses the
   * token's own default. It is resolved lazily at request time if needed.
   */
  async validateApiKey(apiKey, region = "us-east-1") {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw makeApiKeyError("API key is required", "MISSING_KEY");
    }
    const trimmed = apiKey.trim();
    assertValidAwsRegion(region);

    await this.verifyApiKey(trimmed, region);

    return {
      accessToken: trimmed,
      refreshToken: null,
      profileArn: null,
      region,
      authMethod: "api_key",
    };
  }

  /**
   * List available models from CodeWhisperer API
   */
  async listAvailableModels(accessToken, profileArn) {
    const endpoint = "https://codewhisperer.us-east-1.amazonaws.com";
    const target = "AmazonCodeWhispererService.ListAvailableModels";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": target,
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      body: JSON.stringify({
        origin: "AI_EDITOR",
        profileArn,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list models: ${error}`);
    }

    const data = await response.json();
    return (data.models || []).map(m => ({
      id: m.modelId,
      name: m.modelName || m.modelId,
      description: m.description,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      maxInputTokens: m.tokenLimits?.maxInputTokens || 0,
    }));
  }

  /**
   * Fetch user email from access token (optional, for display)
   */
  extractEmailFromJWT(accessToken) {
    try {
      const parts = accessToken.split(".");
      if (parts.length !== 3) return null;

      // Decode payload (add padding if needed)
      let payload = parts[1];
      while (payload.length % 4) {
        payload += "=";
      }

      const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      return decoded.email || decoded.preferred_username || decoded.sub;
    } catch {
      return null;
    }
  }
}
