/**
 * OAuth Provider Configurations and Handlers
 * Centralized DRY approach for all OAuth providers
 */

// Ensure outbound fetch respects HTTP(S)_PROXY/ALL_PROXY in Node runtime
import "open-sse/index.js";
import crypto from "crypto";
import { buildKimiHeaders } from "open-sse/config/appConstants.js";

import { generatePKCE, generateState } from "./utils/pkce";
import {
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CONFIG,
  QWEN_CONFIG,
  QODER_CONFIG,
  QODER_CN_CONFIG,
  IFLOW_CONFIG,
  ANTIGRAVITY_CONFIG,
  GITHUB_CONFIG,
  KIRO_CONFIG,
  assertValidAwsRegion,
  CURSOR_CONFIG,
  KIMI_CODING_CONFIG,
  KILOCODE_CONFIG,
  CLINE_CONFIG,
  CLINEPASS_CONFIG,
  GITLAB_CONFIG,
  CODEBUDDY_CONFIG,
  KIMCHI_CONFIG,
  GROK_CLI_CONFIG,
  MUSE_CONFIG,
  GLM_OAUTH_CONFIG,
  NOUS_CONFIG,
  ZED_HOSTED_CONFIG,
  getOAuthClientMetadata,
} from "./constants/oauth";
import { XAI_CONFIG, XAI_PKCE_VERIFIER_BYTES } from "./constants/xai";
import {
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  extractEmailFromAccessToken,
  extractCodexAccountInfo,
  fetchKiroProfileArn,
  getOAuthFetchProfile,
} from "./providerHelpers";
import { parseKiroProfileArn } from "open-sse/utils/kiroProfileArn.js";
import { registerOAuthState } from "./utils/server.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import {
  createZedNativeAuthData,
  parseZedCallbackPayload,
  decryptZedAccessToken,
  fetchZedAuthenticatedUser,
  resolveZedOrganizationId,
} from "open-sse/shared/zedAuth.js";
import {
  fetchGrokCliUser,
  mapGrokCliTokens,
  pollGrokCliToken,
  requestGrokCliDeviceCode,
} from "./grokCli";

export { extractCodexAccountInfo, fetchKiroProfileArn, createMinimaxCodeProvider, MINIMAX_CODE_SITES };

// Inlined from services/xai.js to keep web route bundle free of `open` (CLI-only) package
let cachedXaiDiscovery = null;

async function discoverXaiEndpoints() {
  if (cachedXaiDiscovery) return cachedXaiDiscovery;
  try {
    const res = await proxyAwareFetch(XAI_CONFIG.discoveryUrl, {
      headers: { Accept: "application/json" },
      identity: "grok-cli",
      provider: "xai",
      format: "openai",
    });
    if (res.ok) {
      const data = await res.json();
      cachedXaiDiscovery = {
        authorizeUrl: validateXaiOAuthEndpoint(data.authorization_endpoint, "authorization_endpoint"),
        tokenUrl: validateXaiOAuthEndpoint(data.token_endpoint, "token_endpoint"),
      };
      return cachedXaiDiscovery;
    }
  } catch { /* fall through to static fallback */ }
  cachedXaiDiscovery = { authorizeUrl: XAI_CONFIG.authorizeUrl, tokenUrl: XAI_CONFIG.tokenUrl };
  return cachedXaiDiscovery;
}

/**
 * Build a Qoder device-code provider for a region. `config` is the registry
 * oauth block (see open-sse/providers/registry/qoder.js / qoder-cn.js), which
 * carries the region's login/deviceToken/userInfo URLs. The device flow is
 * identical across regions — only the hosts differ.
 */
function createQoderProvider(config, providerId = "qoder") {
  const fetchProfile = getOAuthFetchProfile(providerId);
  return {
    config,
    flowType: "device_code",
    // Qoder uses a custom device flow: PKCE + nonce + machine_id are generated
    // locally, the user lands on qoder.com[-cn]/device/selectAccounts in the
    // browser, and we poll the region's deviceToken endpoint until a `dt-...`
    // token appears.
    requestDeviceCode: async (cfg) => {
      const { QoderService } = await import("@/lib/oauth/services/qoder");
      const flow = new QoderService(cfg, fetchProfile).initiateDeviceFlow();
      // Match the device_code shape the rest of the OAuthModal expects
      // (device_code, user_code, verification_uri[_complete], interval).
      // The poll endpoint identifies us by nonce+verifier, not by a
      // server-issued device_code, so we plumb our own values through:
      //   device_code   = nonce  (modal forwards as deviceCode on poll)
      //   codeVerifier  = our PKCE verifier (route forwards as codeVerifier)
      return {
        device_code: flow.nonce,
        user_code: flow.nonce.slice(0, 8).toUpperCase(),
        verification_uri: cfg.loginUrl,
        verification_uri_complete: flow.verificationUriComplete,
        expires_in: 300,
        interval: 2,
        codeVerifier: flow.codeVerifier,
        _qoderNonce: flow.nonce,
        _qoderMachineId: flow.machineId,
      };
    },
    pollToken: async (cfg, deviceCode, codeVerifier, extraData) => {
      const { QoderService } = await import("@/lib/oauth/services/qoder");
      const svc = new QoderService(cfg, fetchProfile);
      const nonce = deviceCode || extraData?._qoderNonce;
      const verifier = codeVerifier || extraData?._qoderVerifier;
      if (!nonce || !verifier) {
        return {
          ok: false,
          data: { error: "invalid_request", error_description: "Missing nonce/verifier" },
        };
      }
      let result;
      try {
        result = await svc.pollDeviceToken({ nonce, codeVerifier: verifier });
      } catch (err) {
        return {
          ok: false,
          data: { error: "poll_failed", error_description: err.message },
        };
      }
      if (result.status === "pending") {
        return { ok: false, data: { error: "authorization_pending" } };
      }
      // Best-effort profile lookup so we have a name/email to display.
      const userInfo = await svc.fetchUserInfo(result.accessToken);
      // expireTime is a Unix-ms timestamp from QoderService.parseExpiry,
      // which already falls back to "now + 30 days" when the upstream
      // omits expiry. Floor to a sane minimum (1 day) so a stale or
      // skewed upstream timestamp doesn't truncate the stored token below
      // something useful.
      const minSeconds = 24 * 60 * 60;
      const remainingSeconds = Math.floor((result.expireTime - Date.now()) / 1000);
      const expiresIn = Math.max(minSeconds, remainingSeconds);
      return {
        ok: true,
        data: {
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          expires_in: expiresIn,
          _qoderUserId: result.userId,
          _qoderMachineId: extraData?._qoderMachineId || "",
          _qoderName: userInfo.name,
          _qoderEmail: userInfo.email,
          _qoderOrganizationId: userInfo.organizationId,
        },
      };
    },
    mapTokens: (tokens) => {
      const rawEmail = (tokens._qoderEmail || "").trim();
      const displayName = (tokens._qoderName || "").trim() || null;
      const userId = tokens._qoderUserId || "";
      // Dedup in createProviderConnection requires a non-empty email. When
      // fetchUserInfo silently fails (returns ""), fall back to a stable
      // synthetic identifier derived from userId so re-logins update the
      // existing row instead of accumulating "Account N" duplicates.
      const email = rawEmail || (userId ? `qoder-user-${userId}` : null);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresIn: tokens.expires_in,
        email,
        displayName,
        providerSpecificData: {
          authMethod: "device",
          userId,
          machineId: tokens._qoderMachineId || "",
          organizationId: tokens._qoderOrganizationId || "",
        },
      };
    },
  };
}

// Provider configurations
// MiniMax Code (mcode) OAuth device flow — shared factory for the two site
// providers (minimax-code = China, minimax-code-global = international).
//
// The flow is MiniMax Code's own sign-in (client mcode-public, PKCE S256),
// but with our own tokens: ~/.minimax is never read or written, so a sign-in
// here does not sign the CLI out and accounts can coexist. Wire shape per
// @magpie-community/opencode-minimax-auth 0.1.1:
//
//   1) POST {account}/oauth2/device/code
//        client_id, scope, audience, code_challenge, code_challenge_method=S256
//        → user_code, verification_uri(_complete), device_code (sometimes
//          absent — MiniMax's variant polls with the user_code instead),
//          expiry as expired_in (ms epoch or seconds) or expires_in, interval
//          (seconds on the standard shape, milliseconds on the user-code one)
//   2) POST {account}/oauth2/token  (one POST per poll; the dashboard drives)
//        grant_type=urn:ietf:params:oauth:grant-type:device_code,
//        device_code|user_code, client_id, code_verifier
//        → {status: pending|slow_down|denied|expired} on 200, or a standard
//          OAuth {error} body; success carries access/refresh_token + expires_in
const MINIMAX_CODE_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MINIMAX_CODE_SIGN_IN_MS = 10 * 60 * 1000;

const minimaxStr = (o, k) => (typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : undefined);
const minimaxPos = (o, k) => (typeof o?.[k] === "number" && Number.isFinite(o[k]) && o[k] > 0 ? o[k] : undefined);

async function minimaxPostForm(url, fields) {
  const provider = new URL(url).hostname === "account.minimax.io" ? "minimax-code-global" : "minimax-code";
  const res = await proxyAwareFetch(url, {
    ...getOAuthFetchProfile(provider), redirect: "error",
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30000),
  });
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {}
  if (!body || typeof body !== "object") body = { error: `invalid_json_response (HTTP ${res.status})` };
  return { status: res.status, body };
}

// MiniMax states the device code's end in odd units: expired_in may be a ms
// epoch or seconds; interval may be seconds (standard shape) or ms (user-code
// shape). Normalize both to the units the dashboard expects.
function minimaxNormalizeDeadline(body) {
  const expiresIn = minimaxPos(body, "expires_in");
  const expiredIn = minimaxPos(body, "expired_in");
  if (expiresIn) return expiresIn;
  if (!expiredIn) return undefined;
  return expiredIn < 1e12 ? expiredIn : Math.max(1, Math.ceil((expiredIn - Date.now()) / 1000));
}

function minimaxNormalizeInterval(body, pollByUser) {
  const interval = minimaxPos(body, "interval");
  if (!interval) return 5;
  if (!pollByUser) return interval; // standard shape: seconds
  return interval >= 60 ? Math.round(interval / 1000) : interval; // user-code shape: ms
}

// Site table — the llm/agent hosts live in the registry transport; only the
// OAuth hosts matter here.
const MINIMAX_CODE_SITES = {
  cn: { account: "https://account.minimax.cn" },
  global: { account: "https://account.minimax.io" },
};

function createMinimaxCodeProvider(site) {
  const pick = (b) => ({
    userCode: minimaxStr(b, "user_code"),
    deviceCode: minimaxStr(b, "device_code"),
    uri: minimaxStr(b, "verification_uri_complete") ?? minimaxStr(b, "verification_uri") ?? minimaxStr(b, "verification_url"),
  });

  return {
    config: {
      clientId: "mcode-public",
      scope: "agent.default",
      audience: "agent-backend",
      deviceUrl: `${site.account}/oauth2/device/code`,
      tokenUrl: `${site.account}/oauth2/token`,
    },
    flowType: "device_code",

    async requestDeviceCode(config, codeChallenge) {
      if (!codeChallenge) throw new Error("MiniMax Code sign-in requires a PKCE code challenge");
      const { status, body } = await minimaxPostForm(config.deviceUrl, {
        client_id: config.clientId,
        scope: config.scope,
        audience: config.audience,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      const { userCode, deviceCode, uri } = pick(body);
      if (!userCode || !uri) {
        throw new Error(`MiniMax device code response unusable (HTTP ${status})`);
      }
      // No device_code → MiniMax's variant: the token endpoint is polled with
      // the user_code itself. Surface the user code as device_code (the modal
      // threads one value through) plus a flag the poll body switches on.
      const pollByUser = !deviceCode;
      return {
        device_code: deviceCode ?? userCode,
        user_code: userCode,
        verification_uri: uri,
        expires_in: minimaxNormalizeDeadline(body) ?? Math.floor(MINIMAX_CODE_SIGN_IN_MS / 1000),
        interval: minimaxNormalizeInterval(body, pollByUser),
        _minimaxPollByUser: pollByUser,
      };
    },

    async pollToken(config, deviceCode, codeVerifier, extraData) {
      if (!deviceCode) return { ok: true, data: { error: "authorization_pending" } };
      const fields = {
        grant_type: MINIMAX_CODE_DEVICE_GRANT,
        ...(extraData?._minimaxPollByUser ? { user_code: deviceCode } : { device_code: deviceCode }),
        client_id: config.clientId,
        code_verifier: codeVerifier,
      };
      const { body } = await minimaxPostForm(config.tokenUrl, fields);

      // MiniMax's own envelope: {status: ...} on HTTP 200.
      const status = minimaxStr(body, "status");
      if (status === "pending") return { ok: true, data: { error: "authorization_pending" } };
      if (status === "slow_down") return { ok: true, data: { error: "slow_down" } };
      if (status === "denied" || status === "access_denied") return { ok: true, data: { error: "access_denied" } };
      if (status === "expired" || status === "expired_token") return { ok: true, data: { error: "expired_token" } };
      if (status) return { ok: true, data: { error: `unexpected_status:${status}` } };

      // Standard OAuth error body on the same call.
      if (minimaxStr(body, "error")) return { ok: true, data: { error: minimaxStr(body, "error"), error_description: minimaxStr(body, "error_description") } };

      if (!minimaxStr(body, "access_token")) return { ok: true, data: { error: "no_access_token" } };
      return { ok: true, data: body };
    },

    mapTokens(data) {
      const expiresIn = minimaxPos(data, "expires_in");
      return {
        accessToken: minimaxStr(data, "access_token"),
        refreshToken: minimaxStr(data, "refresh_token") ?? "",
        expiresIn: expiresIn ?? 3600,
      };
    },
  };
}

// ── Zai GLM Coding (ZCode CLI polling OAuth) ────────────────────────────────
// Business JWT → coding-plan API key ("apiKey.secretKey"). Mirrors ZCode CLI
// coding-plan-api-key.ts: getCustomerInfo → default org/project → api_keys
// list/create("zcode-api-key") → copy → secretKey.
async function resolveCodingPlanApiKey(config, zaiAccessToken) {
  const businessToken = await exchangeBusinessToken(config, zaiAccessToken);
  const authHeaders = {
    Authorization: `Bearer ${businessToken}`,
    "Content-Type": "application/json",
  };

  const customerInfo = await fetchBusinessJson(
    `${config.apiBaseUrl}/api/biz/customer/getCustomerInfo`,
    { headers: authHeaders },
    "customer info"
  );
  const location = pickOrgAndProject(customerInfo);
  if (!location) {
    throw new Error("Unable to resolve Z.ai organization and project for the coding plan");
  }

  const listUrl =
    `${config.apiBaseUrl}/api/biz/v1/organization/${location.organizationId}` +
    `/projects/${location.projectId}/api_keys`;
  const keys = (await fetchBusinessJson(listUrl, { headers: authHeaders }, "api keys")) || [];
  let keyEntry = Array.isArray(keys)
    ? keys.find((item) => item?.name === config.planApiKeyName)
    : null;
  if (!keyEntry) {
    keyEntry = await fetchBusinessJson(
      listUrl,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name: config.planApiKeyName }),
      },
      "api key create"
    );
  }

  const apiKey = keyEntry?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Z.ai api_keys response is missing apiKey");
  }

  const secret = await fetchBusinessJson(
    `${listUrl}/copy/${encodeURIComponent(apiKey)}`,
    { headers: authHeaders },
    "api key copy"
  );
  const secretKey = secret?.secretKey?.trim();
  if (!secretKey) {
    throw new Error("Z.ai api key copy response is missing secretKey");
  }

  return { planApiKey: `${apiKey}.${secretKey}`, businessToken };
}

// POST {businessLoginUrl} {"token": <zai oauth token>} → { data: { access_token } }
async function exchangeBusinessToken(config, zaiAccessToken) {
  const payload = await fetchBusinessJson(
    config.businessLoginUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: zaiAccessToken }),
    },
    "Z.ai business login"
  );
  const token = payload?.access_token?.trim() || payload?.accessToken?.trim();
  if (!token) {
    throw new Error("Z.ai business login response is missing access_token");
  }
  return token;
}

// Business endpoints answer {code, msg, data}; code 0/200 (or absent) = success.
// data is returned directly (null when missing).
async function fetchBusinessJson(url, options, label) {
  const response = await proxyAwareFetch(url, { ...options, ...getOAuthFetchProfile("glm"),
    redirect: "error", signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Z.ai ${label} request failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Z.ai ${label} response is not valid JSON`);
  }
  if (!isSuccessCode(payload?.code) || payload?.success === false) {
    throw new Error(payload?.msg || `Z.ai ${label} returned business error ${payload?.code}`);
  }
  return payload?.data ?? payload ?? null;
}

// Prefer the org named "默认机构"/"default" and the non-team project named
// "默认项目"/"default" (projectType "2" = team), falling back to the first entries.
function pickOrgAndProject(customerInfo) {
  const organizations = Array.isArray(customerInfo?.organizations)
    ? customerInfo.organizations
    : [];
  const personalOrgs = organizations
    .map((organization) => ({
      organization,
      projects: (organization?.projects || []).filter(
        (project) => String(project?.projectType ?? "").trim() !== "2"
      ),
    }))
    .filter(({ organization, projects }) =>
      Boolean(organization?.organizationId && projects.length)
    );
  if (!personalOrgs.length) return null;

  const org =
    personalOrgs.find(({ organization }) => isDefaultName(organization.organizationName)) ||
    personalOrgs[0];
  const project =
    org.projects.find((item) => isDefaultName(item?.projectName)) || org.projects[0];
  if (!org.organization?.organizationId || !project?.projectId) return null;
  return { organizationId: org.organization.organizationId, projectId: project.projectId };
}

function isDefaultName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return normalized.includes("默认机构") || normalized.includes("默认项目") || normalized === "default";
}

function isSuccessCode(code) {
  return code === undefined || code === null || code === 0 || code === 200 || code === "0" || code === "200";
}

// Absolute epoch (s or ms) → seconds from now; null when absent/invalid.
function relativeSeconds(expiresAt) {
  const raw = Number(expiresAt);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const seconds = Math.floor((ms - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
}



const PROVIDERS = {
  claude: {
    config: CLAUDE_CONFIG,
    flowType: "authorization_code_pkce",
    buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
      const params = new URLSearchParams({
        code: "true",
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod,
        state: state,
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri, codeVerifier, state) => {
      // Parse code - may contain state after #
      let authCode = code;
      let codeState = "";
      if (authCode.includes("#")) {
        const parts = authCode.split("#");
        authCode = parts[0];
        codeState = parts[1] || "";
      }

      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          code: authCode,
          state: codeState || state,
          grant_type: "authorization_code",
          client_id: config.clientId,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
        ...getOAuthFetchProfile("claude"),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    }),
  },

  codex: {
    config: CODEX_CONFIG,
    flowType: "authorization_code_pkce",
    fixedPort: CODEX_CONFIG.fixedPort,
    callbackPath: CODEX_CONFIG.callbackPath,
    buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
      const params = {
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scope,
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod,
        ...config.extraParams,
        state: state,
      };
      const queryString = Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("&");
      return `${config.authorizeUrl}?${queryString}`;
    },
    exchangeToken: async (config, code, redirectUri, codeVerifier) => {
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          code: code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
        ...getOAuthFetchProfile("codex"),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    mapTokens: (tokens) => {
      const info = extractCodexAccountInfo(tokens.id_token);
      const mapped = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in,
        lastRefreshAt: new Date().toISOString(),
      };
      const email = info.email || extractEmailFromAccessToken(tokens.access_token);
      if (email) mapped.email = email;
      if (info.chatgptAccountId || info.chatgptPlanType) {
        mapped.providerSpecificData = {
          chatgptAccountId: info.chatgptAccountId,
          chatgptPlanType: info.chatgptPlanType,
        };
      }
      return mapped;
    },
  },

  xai: {
    config: XAI_CONFIG,
    flowType: "authorization_code_pkce",
    fixedPort: XAI_CONFIG.loopbackPort,
    callbackPath: XAI_CONFIG.callbackPath,
    pkceVerifierBytes: XAI_PKCE_VERIFIER_BYTES,
    prepareConfig: async (config) => {
      const endpoints = await discoverXaiEndpoints();
      return {
        ...config,
        authorizeUrl: endpoints.authorizeUrl,
        tokenUrl: endpoints.tokenUrl,
      };
    },
    buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
      // Mirror CLIProxyAPI BuildAuthorizeURL: includes nonce, plan, referrer
      const nonce = crypto.randomBytes(16).toString("hex");
      const params = {
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scope,
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod,
        state,
        nonce,
        plan: "generic",
        referrer: "cli-proxy-api",
      };
      const qs = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
      return `${config.authorizeUrl}?${qs}`;
    },
    exchangeToken: async (config, code, redirectUri, codeVerifier) => {
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
        identity: "grok-cli",
        provider: "xai",
        format: "openai",
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`xAI token exchange failed: ${error}`);
      }
      return await response.json();
    },
    mapTokens: (tokens) => {
      const mapped = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
      };
      const email = decodeXaiIdTokenEmail(tokens.id_token);
      if (email) mapped.email = email;
      if (tokens.id_token) {
        mapped.providerSpecificData = { idToken: tokens.id_token };
      }
      return mapped;
    },
  },

  "grok-cli": {
    config: GROK_CLI_CONFIG,
    flowType: "device_code",
    requestDeviceCode: requestGrokCliDeviceCode,
    pollToken: (config, deviceCode) => pollGrokCliToken(config, deviceCode),
    postExchange: fetchGrokCliUser,
    mapTokens: mapGrokCliTokens,
  },

  "gemini-cli": {
    config: GEMINI_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri, state) => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        state: state,
        access_type: "offline",
        prompt: "consent",
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: code,
          redirect_uri: redirectUri,
        }),
        ...getOAuthFetchProfile("gemini-cli"),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    postExchange: async (tokens) => {
      // Fetch user info
      const userInfoRes = await proxyAwareFetch(`${GEMINI_CONFIG.userInfoUrl}?alt=json`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        ...getOAuthFetchProfile("gemini-cli"),
      });
      const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

      // Fetch project ID
      let projectId = "";
      try {
        const projectRes = await proxyAwareFetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metadata: getOAuthClientMetadata(),
            mode: 1,
          }),
          ...getOAuthFetchProfile("gemini-cli"),
        });
        if (projectRes.ok) {
          const data = await projectRes.json();
          projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
        }
      } catch (e) {
        console.log("Failed to fetch project ID:", e);
      }

      return { userInfo, projectId };
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      email: extra?.userInfo?.email,
      projectId: extra?.projectId,
    }),
  },

  antigravity: {
    config: ANTIGRAVITY_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri, state) => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        state: state,
        access_type: "offline",
        prompt: "consent",
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: code,
          redirect_uri: redirectUri,
        }),
        identity: "antigravity",
        provider: "antigravity",
        format: "antigravity",
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    postExchange: async (tokens) => {
      // Numeric enums matching Antigravity binary ClientMetadata
      const loadHeaders = {
        "Authorization": `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        "X-Goog-Api-Client": ANTIGRAVITY_CONFIG.loadCodeAssistApiClient,
        "Client-Metadata": ANTIGRAVITY_CONFIG.loadCodeAssistClientMetadata,
      };
      const metadata = getOAuthClientMetadata();

      // Fetch user info
      const userInfoRes = await proxyAwareFetch(`${ANTIGRAVITY_CONFIG.userInfoUrl}?alt=json`, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
        identity: "antigravity",
        provider: "antigravity",
        format: "antigravity",
      });
      const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

      // Load Code Assist to get project ID and tier
      let projectId = "";
      let tierId = "legacy-tier";
      try {
        const loadRes = await proxyAwareFetch(ANTIGRAVITY_CONFIG.loadCodeAssistEndpoint, {
          method: "POST",
          headers: loadHeaders,
          body: JSON.stringify({ metadata }),
          identity: "antigravity",
          provider: "antigravity",
          format: "antigravity",
        });
        if (loadRes.ok) {
          const data = await loadRes.json();
          projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
          if (Array.isArray(data.allowedTiers)) {
            for (const tier of data.allowedTiers) {
              if (tier.isDefault && tier.id) {
                tierId = tier.id.trim();
                break;
              }
            }
          }
        }
      } catch (e) {
        console.log("Failed to load code assist:", e);
      }

      // Fire-and-forget onboarding — does not block DB save
      if (projectId) {
        const doOnboard = async () => {
          for (let i = 0; i < 10; i++) {
            try {
              const onboardRes = await proxyAwareFetch(ANTIGRAVITY_CONFIG.onboardUserEndpoint, {
                method: "POST",
                headers: loadHeaders,
                body: JSON.stringify({ tierId, metadata }),
                identity: "antigravity",
                provider: "antigravity",
                format: "antigravity",
              });
              if (onboardRes.ok) {
                const result = await onboardRes.json();
                if (result.done === true) break;
              }
            } catch (e) {
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        };
        doOnboard().catch(() => {});
      }

      return { userInfo, projectId };
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      email: extra?.userInfo?.email,
      projectId: extra?.projectId,
    }),
  },

  iflow: {
    config: IFLOW_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri, state) => {
      const params = new URLSearchParams({
        loginMethod: config.extraParams.loginMethod,
        type: config.extraParams.type,
        redirect: redirectUri,
        state: state,
        client_id: config.clientId,
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      // Create Basic Auth header
      const basicAuth = Buffer.from(
        `${config.clientId}:${config.clientSecret}`
      ).toString("base64");

      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        ...getOAuthFetchProfile("iflow"),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      return await response.json();
    },
    postExchange: async (tokens) => {
      // Fetch user info (MUST succeed to get API key)
      const userInfoRes = await proxyAwareFetch(`${IFLOW_CONFIG.userInfoUrl}?accessToken=${encodeURIComponent(tokens.access_token)}`, {
        headers: {
          Accept: "application/json",
        },
        ...getOAuthFetchProfile("iflow"),
      });
      
      if (!userInfoRes.ok) {
        const errorText = await userInfoRes.text();
        throw new Error(`Failed to fetch user info: ${errorText}`);
      }
      
      const result = await userInfoRes.json();
      if (!result.success) {
        throw new Error(`User info request failed: ${result.message || 'Unknown error'}`);
      }
      
      const userInfo = result.data || {};
      
      // Validate API key (critical for iFlow)
      if (!userInfo.apiKey || userInfo.apiKey.trim() === "") {
        throw new Error("Empty API key returned from iFlow");
      }
      
      // Validate email/phone
      const email = userInfo.email?.trim() || userInfo.phone?.trim();
      if (!email) {
        throw new Error("Missing account email/phone in user info");
      }
      
      return { userInfo };
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      apiKey: extra?.userInfo?.apiKey,
      email: extra?.userInfo?.email || extra?.userInfo?.phone,
      displayName: extra?.userInfo?.nickname || extra?.userInfo?.name,
    }),
  },

  qoder: createQoderProvider(QODER_CONFIG, "qoder"),
  "qoder-cn": createQoderProvider(QODER_CN_CONFIG, "qoder-cn"),
  qwen: {
    config: QWEN_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config, codeChallenge) => {
      const response = await proxyAwareFetch(config.deviceCodeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          scope: config.scope,
          code_challenge: codeChallenge,
          code_challenge_method: config.codeChallengeMethod,
        }),
        ...getOAuthFetchProfile("qwen"),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Device code request failed: ${error}`);
      }

      return await response.json();
    },
    pollToken: async (config, deviceCode, codeVerifier) => {
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.clientId,
          device_code: deviceCode,
          code_verifier: codeVerifier,
        }),
        ...getOAuthFetchProfile("qwen"),
      });

      // chat.qwen.ai fronts the token endpoint with the alibaba-ga gateway, which
      // intermittently answers 504 with an HTML error page. Parsing that as JSON
      // throws "Unexpected token '<'" and aborts the whole connect dialog. Treat
      // non-JSON / 5xx / 429 bodies as transient and keep the device-code poll going.
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!data) {
        if (!response.ok && (response.status >= 500 || response.status === 429)) {
          return { ok: false, data: { error: "authorization_pending" } };
        }
        return { ok: false, data: { error: `token_endpoint_http_${response.status}` } };
      }
      return { ok: response.ok, data };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      providerSpecificData: { resourceUrl: tokens.resource_url },
    }),
  },

  github: {
    config: GITHUB_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await proxyAwareFetch(config.deviceCodeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          scope: config.scopes,
        }),
        ...getOAuthFetchProfile("github"),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Device code request failed: ${error}`);
      }

      return await response.json();
    },
    pollToken: async (config, deviceCode) => {
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        ...getOAuthFetchProfile("github"),
      });

      // Handle response properly - if not ok, try to get error as text first
      let data;
      try {
        data = await response.json();
      } catch (e) {
        // If response is not JSON, get as text
        const text = await response.text();
        data = { error: "invalid_response", error_description: text };
      }

      return {
        ok: response.ok,
        data: data,
      };
    },
    postExchange: async (tokens) => {
      // Get Copilot token using GitHub access token
      const copilotRes = await proxyAwareFetch(GITHUB_CONFIG.copilotTokenUrl, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
        },
        identity: "copilot",
        provider: "github",
        format: "openai",
      });
      const copilotToken = copilotRes.ok ? await copilotRes.json() : {};

      // Get user info from GitHub
      const userRes = await proxyAwareFetch(GITHUB_CONFIG.userInfoUrl, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
          "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
        },
        identity: "copilot",
        provider: "github",
        format: "openai",
      });
      const userInfo = userRes.ok ? await userRes.json() : {};

      return { copilotToken, userInfo };
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      providerSpecificData: {
        copilotToken: extra?.copilotToken?.token,
        copilotTokenExpiresAt: extra?.copilotToken?.expires_at,
        githubUserId: extra?.userInfo?.id,
        githubLogin: extra?.userInfo?.login,
        githubName: extra?.userInfo?.name,
        githubEmail: extra?.userInfo?.email,
      },
    }),
  },

  kiro: {
    config: KIRO_CONFIG,
    flowType: "device_code",
    // Kiro uses AWS SSO OIDC - requires client registration first
    requestDeviceCode: async (config, codeChallenge, options = {}) => {
      const trimmedRegion = typeof options.region === "string" ? options.region.trim() : "";
      const region = trimmedRegion || "us-east-1";
      assertValidAwsRegion(region);
      const trimmedStartUrl = typeof options.startUrl === "string" ? options.startUrl.trim() : "";
      const startUrl = trimmedStartUrl || config.startUrl;
      const authMethod = options.authMethod === "idc" ? "idc" : "builder-id";
      const registerClientUrl = `https://oidc.${region}.amazonaws.com/client/register`;
      const deviceAuthUrl = `https://oidc.${region}.amazonaws.com/device_authorization`;

      // Step 1: Register client with AWS SSO OIDC
      const registerRes = await proxyAwareFetch(registerClientUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          clientName: config.clientName,
          clientType: config.clientType,
          scopes: config.scopes,
          grantTypes: config.grantTypes,
          issuerUrl: config.issuerUrl,
        }),
        ...getOAuthFetchProfile("kiro"),
      });

      if (!registerRes.ok) {
        const error = await registerRes.text();
        throw new Error(`Client registration failed: ${error}`);
      }

      const clientInfo = await registerRes.json();

      // Step 2: Request device authorization
      const deviceRes = await proxyAwareFetch(deviceAuthUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          clientId: clientInfo.clientId,
          clientSecret: clientInfo.clientSecret,
          startUrl,
        }),
        ...getOAuthFetchProfile("kiro"),
      });

      if (!deviceRes.ok) {
        const error = await deviceRes.text();
        throw new Error(`Device authorization failed: ${error}`);
      }

      const deviceData = await deviceRes.json();

      // Return combined data for polling
      return {
        device_code: deviceData.deviceCode,
        user_code: deviceData.userCode,
        verification_uri: deviceData.verificationUri,
        verification_uri_complete: deviceData.verificationUriComplete,
        expires_in: deviceData.expiresIn,
        interval: deviceData.interval || 5,
        // Store client credentials for token exchange
        _clientId: clientInfo.clientId,
        _clientSecret: clientInfo.clientSecret,
        _region: region,
        _authMethod: authMethod,
        _startUrl: startUrl,
      };
    },
    pollToken: async (config, deviceCode, codeVerifier, extraData) => {
      const region = extraData?._region || "us-east-1";
      assertValidAwsRegion(region);
      const suppliedProfile = parseKiroProfileArn(extraData?._profileArn);
      if (extraData?._profileArn && !suppliedProfile) {
        throw new Error("A valid Kiro profile ARN is required for IAM Identity Center");
      }
      const tokenUrl = `https://oidc.${region}.amazonaws.com/token`;
      const response = await proxyAwareFetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          clientId: extraData?._clientId,
          clientSecret: extraData?._clientSecret,
          deviceCode: deviceCode,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        ...getOAuthFetchProfile("kiro"),
      });

      let data;
      try {
        data = await response.json();
      } catch (e) {
        const text = await response.text();
        data = { error: "invalid_response", error_description: text };
      }

      // AWS SSO OIDC returns camelCase
      if (data.accessToken) {
        const returnedProfile = parseKiroProfileArn(data.profileArn);
        const discoveredProfileArn = returnedProfile?.profileArn
          || suppliedProfile?.profileArn
          || await fetchKiroProfileArn(data.accessToken, region);
        if (extraData?._authMethod === "idc" && !discoveredProfileArn) {
          throw new Error(
            "Kiro did not return an enterprise profile. Check that the subscription is active, or enter a profile ARN from `kiro-cli whoami`.",
          );
        }
        return {
          ok: true,
          data: {
            access_token: data.accessToken,
            refresh_token: data.refreshToken,
            expires_in: data.expiresIn,
            profile_arn: discoveredProfileArn,
            // Store client credentials for refresh
            _clientId: extraData?._clientId,
            _clientSecret: extraData?._clientSecret,
            _region: extraData?._region,
            _authMethod: extraData?._authMethod,
            _startUrl: extraData?._startUrl,
          },
        };
      }

      return {
        ok: false,
        data: {
          error: data.error || "authorization_pending",
          error_description: data.error_description || data.message,
        },
      };
    },
    mapTokens: (tokens) => {
      const email = extractEmailFromAccessToken(tokens.access_token);
      const mapped = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        email,
        providerSpecificData: {
          profileArn: tokens?.profile_arn || null,
          clientId: tokens._clientId,
          clientSecret: tokens._clientSecret,
          region: tokens._region || "us-east-1",
          authMethod: tokens._authMethod || "builder-id",
          startUrl: tokens._startUrl || KIRO_CONFIG.startUrl,
        },
      };
      return mapped;
    },
  },

  cursor: {
    config: CURSOR_CONFIG,
    flowType: "import_token",
    // Cursor uses import token flow - tokens are extracted from local SQLite database
    // No OAuth flow needed, handled by /api/oauth/cursor/import route
    mapTokens: (tokens) => ({
      accessToken: tokens.accessToken,
      refreshToken: null, // Cursor doesn't have public refresh endpoint
      expiresIn: tokens.expiresIn || 86400,
      providerSpecificData: {
        machineId: tokens.machineId,
        authMethod: "imported",
      },
    }),
  },

  "kimi-coding": {
    config: KIMI_CODING_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      // X-Msh-Device-Id must stay constant for the whole OAuth session: mint it
      // here and thread it through pollToken into providerSpecificData.
      const deviceId = crypto.randomUUID();
      const response = await proxyAwareFetch(config.deviceCodeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...buildKimiHeaders(deviceId),
        },
        body: new URLSearchParams({ client_id: config.clientId }),
        ...getOAuthFetchProfile("kimi-coding"),
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Device code request failed: ${error}`);
      }
      const data = await response.json();
      return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri || "https://www.kimi.com/code/authorize_device",
        verification_uri_complete:
          data.verification_uri_complete ||
          `https://www.kimi.com/code/authorize_device?user_code=${data.user_code}`,
        expires_in: data.expires_in,
        interval: data.interval || 5,
        _kimiDeviceId: deviceId,
      };
    },
    pollToken: async (config, deviceCode, _codeVerifier, extraData) => {
      const deviceId = extraData?._kimiDeviceId;
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...buildKimiHeaders(deviceId),
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.clientId,
          device_code: deviceCode,
        }),
        ...getOAuthFetchProfile("kimi-coding"),
      });
      let data;
      try {
        data = await response.json();
      } catch (e) {
        const text = await response.text();
        data = { error: "invalid_response", error_description: text };
      }
      if (data.access_token && deviceId) data._kimiDeviceId = deviceId;
      return { ok: response.ok, data };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      ...(tokens._kimiDeviceId
        ? { providerSpecificData: { deviceId: tokens._kimiDeviceId } }
        : {}),
    }),
  },

  kilocode: {
    config: KILOCODE_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await proxyAwareFetch(config.initiateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...getOAuthFetchProfile("kilocode"),
      });
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("Too many pending authorization requests. Please try again later.");
        }
        const error = await response.text();
        throw new Error(`Device auth initiation failed: ${error}`);
      }
      const data = await response.json();
      return {
        device_code: data.code,
        user_code: data.code,
        verification_uri: data.verificationUrl,
        verification_uri_complete: data.verificationUrl,
        expires_in: data.expiresIn || 300,
        interval: 3,
      };
    },
    pollToken: async (config, deviceCode) => {
      const response = await proxyAwareFetch(`${config.pollUrlBase}/${deviceCode}`, {
        ...getOAuthFetchProfile("kilocode"),
      });
      if (response.status === 202) return { ok: false, data: { error: "authorization_pending" } };
      if (response.status === 403) return { ok: false, data: { error: "access_denied", error_description: "Authorization denied by user" } };
      if (response.status === 410) return { ok: false, data: { error: "expired_token", error_description: "Authorization code expired" } };
      if (!response.ok) return { ok: false, data: { error: "poll_failed", error_description: `Poll failed: ${response.status}` } };
      const data = await response.json();
      if (data.status === "approved" && data.token) {
        // Fetch profile to get orgId for X-Kilocode-OrganizationID header
        let orgId = null;
        try {
          const profileRes = await proxyAwareFetch(`${config.apiBaseUrl}/api/profile`, {
            headers: { "Authorization": `Bearer ${data.token}` },
            ...getOAuthFetchProfile("kilocode"),
          });
          if (profileRes.ok) {
            const profile = await profileRes.json();
            orgId = profile.organizations?.[0]?.id || null;
          }
        } catch {}
        return { ok: true, data: { access_token: data.token, _userEmail: data.userEmail, _orgId: orgId } };
      }
      return { ok: false, data: { error: "authorization_pending" } };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: null,
      expiresIn: null,
      email: tokens._userEmail,
      ...(tokens._orgId ? { providerSpecificData: { orgId: tokens._orgId } } : {}),
    }),
  },

  cline: {
    config: CLINE_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri) => {
      const params = new URLSearchParams({
        client_type: "extension",
        callback_url: redirectUri,
        redirect_uri: redirectUri,
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      try {
        // Cline encodes token data as base64 in the code param
        let base64 = code;
        const padding = 4 - (base64.length % 4);
        if (padding !== 4) base64 += "=".repeat(padding);
        const decoded = Buffer.from(base64, "base64").toString("utf-8");
        const lastBrace = decoded.lastIndexOf("}");
        if (lastBrace === -1) throw new Error("No JSON found in decoded code");
        const tokenData = JSON.parse(decoded.substring(0, lastBrace + 1));
        return {
          access_token: tokenData.accessToken,
          refresh_token: tokenData.refreshToken,
          email: tokenData.email,
          firstName: tokenData.firstName,
          lastName: tokenData.lastName,
          expires_at: tokenData.expiresAt,
        };
      } catch (e) {
        const response = await proxyAwareFetch(config.tokenExchangeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ grant_type: "authorization_code", code, client_type: "extension", redirect_uri: redirectUri }),
          ...getOAuthFetchProfile("cline"),
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Cline token exchange failed: ${error}`);
        }
        const data = await response.json();
        return {
          access_token: data.data?.accessToken || data.accessToken,
          refresh_token: data.data?.refreshToken || data.refreshToken,
          email: data.data?.userInfo?.email || "",
          expires_at: data.data?.expiresAt || data.expiresAt,
        };
      }
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_at
        ? Math.floor((new Date(tokens.expires_at).getTime() - Date.now()) / 1000)
        : 3600,
      email: tokens.email,
      providerSpecificData: { firstName: tokens.firstName, lastName: tokens.lastName },
    }),
  },
  clinepass: {
    config: CLINEPASS_CONFIG,
    flowType: "authorization_code",
    buildAuthUrl: (config, redirectUri) => {
      const params = new URLSearchParams({
        client_type: "extension",
        callback_url: redirectUri,
        redirect_uri: redirectUri,
      });
      return `${config.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri) => {
      try {
        // Cline encodes token data as base64 in the code param
        let base64 = code;
        const padding = 4 - (base64.length % 4);
        if (padding !== 4) base64 += "=".repeat(padding);
        const decoded = Buffer.from(base64, "base64").toString("utf-8");
        const lastBrace = decoded.lastIndexOf("}");
        if (lastBrace === -1) throw new Error("No JSON found in decoded code");
        const tokenData = JSON.parse(decoded.substring(0, lastBrace + 1));
        return {
          access_token: tokenData.accessToken,
          refresh_token: tokenData.refreshToken,
          email: tokenData.email,
          firstName: tokenData.firstName,
          lastName: tokenData.lastName,
          expires_at: tokenData.expiresAt,
        };
      } catch (e) {
        const response = await proxyAwareFetch(config.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ grant_type: "authorization_code", code, client_type: "extension", redirect_uri: redirectUri }),
          ...getOAuthFetchProfile("clinepass"),
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`ClinePass token exchange failed: ${error}`);
        }
        const data = await response.json();
        return {
          access_token: data.data?.accessToken || data.accessToken,
          refresh_token: data.data?.refreshToken || data.refreshToken,
          email: data.data?.userInfo?.email || "",
          expires_at: data.data?.expiresAt || data.expiresAt,
        };
      }
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_at
        ? Math.floor((new Date(tokens.expires_at).getTime() - Date.now()) / 1000)
        : 3600,
      email: tokens.email,
      providerSpecificData: { firstName: tokens.firstName, lastName: tokens.lastName },
    }),
  },
  // GitLab Duo - Authorization Code Flow with PKCE
  // Supports two login modes via loginMode metadata: "oauth" (default) or "pat"
  gitlab: {
    config: GITLAB_CONFIG,
    flowType: "authorization_code_pkce",
    buildAuthUrl: (config, redirectUri, state, codeChallenge, meta = {}) => {
      const baseUrl = meta.baseUrl || config.defaultBaseUrl;
      const clientId = meta.clientId || "";
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        scope: config.scope,
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod,
      });
      return `${baseUrl}${config.authorizeUrlPath}?${params.toString()}`;
    },
    exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta = {}) => {
      const baseUrl = meta.baseUrl || config.defaultBaseUrl;
      const clientId = meta.clientId || "";
      const clientSecret = meta.clientSecret || "";
      const body = new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      if (clientSecret) body.set("client_secret", clientSecret);
      const response = await proxyAwareFetch(`${baseUrl}${config.tokenUrlPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
        ...getOAuthFetchProfile("gitlab"),
      });
      if (!response.ok) throw new Error(`GitLab token exchange failed: ${await response.text()}`);
      const tokens = await response.json();
      // Fetch user info
      const userRes = await proxyAwareFetch(`${baseUrl}${config.userInfoUrlPath}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        ...getOAuthFetchProfile("gitlab"),
      });
      const user = userRes.ok ? await userRes.json() : {};
      return { ...tokens, _user: user, _baseUrl: baseUrl, _clientId: clientId };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      providerSpecificData: {
        username: tokens._user?.username || "",
        email: tokens._user?.email || tokens._user?.public_email || "",
        name: tokens._user?.name || "",
        baseUrl: tokens._baseUrl,
        clientId: tokens._clientId,
        authKind: "oauth",
      },
    }),
  },

  // CodeBuddy (Tencent) - Browser OAuth Polling Flow
  // 1. POST stateUrl → get { state, authUrl }
  // 2. Open authUrl in browser
  // 3. Poll tokenUrl with state until success (code 0) or timeout
  "codebuddy-cn": {
    config: CODEBUDDY_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await proxyAwareFetch(`${config.stateUrl}?platform=${config.platform}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": config.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": "copilot.tencent.com",
          "X-No-Authorization": "true",
          "X-No-User-Id": "true",
          "X-Product": "SaaS",
        },
        body: "{}",
        ...getOAuthFetchProfile("codebuddy-cn"),
      });
      if (!response.ok) throw new Error(`CodeBuddy state request failed: ${await response.text()}`);
      const data = await response.json();
      if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
        throw new Error(`CodeBuddy state error: ${data.msg || "missing state/authUrl"}`);
      }
      return {
        device_code: data.data.state,
        verification_uri: data.data.authUrl,
        user_code: "",
        interval: config.pollInterval / 1000,
        _isCodeBuddy: true,
      };
    },
    pollToken: async (config, deviceCode) => {
      // CodeBuddy polls the token endpoint via GET with the state as a query
      // param (not POST/body) — matches the official CLI's /v2/plugin/auth/token?state=...
      const response = await proxyAwareFetch(`${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": config.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": "copilot.tencent.com",
          "X-No-Authorization": "true",
          "X-No-User-Id": "true",
          "X-No-Enterprise-Id": "true",
          "X-No-Department-Info": "true",
          "X-Product": "SaaS",
        },
        ...getOAuthFetchProfile("codebuddy-cn"),
      });
      if (!response.ok) return { ok: false, data: { error: "request_failed" } };
      const data = await response.json();
      // code 11217 = pending (RetryFetchToken), code 0 = success
      if (data.code === 0 && data.data?.accessToken) {
        return {
          ok: true,
          data: {
            access_token: data.data.accessToken,
            refresh_token: data.data.refreshToken || "",
            token_type: data.data.tokenType || "Bearer",
            expires_in: data.data.expiresIn,
          },
        };
      }
      if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
      return { ok: false, data: { error: data.msg || "unknown_error" } };
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || 86400,
      providerSpecificData: {},
    }),
  },

  kimchi: {
    config: KIMCHI_CONFIG,
    flowType: "browser_token",
    buildAuthUrl: (config, redirectUri, state) => {
      const baseUrl = (config.webAppUrl || "https://app.kimchi.dev").replace(/\/+$/, "");
      const params = new URLSearchParams({
        callback: redirectUri,
        state,
      });
      return `${baseUrl}/cli-auth?${params.toString()}`;
    },
    exchangeToken: async (config, token) => {
      const accessToken = String(token || "").trim();
      if (!accessToken) {
        throw new Error("Missing Kimchi token");
      }

      const validationUrl = config.validationUrl || "https://api.cast.ai/v1/llm/openai/supported-providers";
      const validationRes = await proxyAwareFetch(validationUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        ...getOAuthFetchProfile("kimchi"),
      });
      if (!validationRes.ok) {
        throw new Error(`Kimchi token validation failed: ${validationRes.status}`);
      }

      let userInfo = {};
      if (config.userInfoUrl) {
        try {
          const userRes = await proxyAwareFetch(config.userInfoUrl, {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            ...getOAuthFetchProfile("kimchi"),
          });
          if (userRes.ok) {
            userInfo = await userRes.json();
          }
        } catch {
          userInfo = {};
        }
      }

      return {
        access_token: accessToken,
        token_type: "Bearer",
        _kimchiUser: userInfo,
      };
    },
    mapTokens: (tokens) => {
      const user = tokens._kimchiUser || {};
      const userId = user.id ? String(user.id) : "";
      const username = user.username || "";
      const email = user.email || (userId ? `kimchi-user-${userId}` : null);
      return {
        accessToken: tokens.access_token,
        refreshToken: null,
        email,
        displayName: user.name || username || null,
        providerSpecificData: {
          authMethod: "browser_token",
          userId,
          username,
        },
      };
    },
  },

  muse: {
    config: MUSE_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await proxyAwareFetch(config.deviceCodeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "muse-code/1.0.2",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
        }),
        ...getOAuthFetchProfile("muse"),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Meta device code request failed: ${error}`);
      }

      const data = await response.json();
      return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        verification_uri_complete: data.verification_uri_complete,
        expires_in: data.expires_in,
        interval: data.interval || 5,
      };
    },
    pollToken: async (config, deviceCode) => {
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "muse-code/1.0.2",
        },
        body: new URLSearchParams({
          grant_type: config.grantType || "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.clientId,
          device_code: deviceCode,
        }),
        ...getOAuthFetchProfile("muse"),
      });

      const bodyText = await response.text();
      let data;
      try {
        data = JSON.parse(bodyText);
      } catch {
        return { ok: false, data: { error: `invalid_json: ${bodyText.slice(0, 200)}` } };
      }

      if (response.ok && data.access_token) {
        return { ok: true, data };
      }

      if (data.error === "authorization_pending" || data.error === "slow_down") {
        return { ok: true, data };
      }

      return {
        ok: false,
        data: {
          error: data.error || `HTTP ${response.status}`,
          error_description: data.error_description || data.message || bodyText,
        },
      };
    },
    postExchange: async (tokenData) => {
      const dcaToken = tokenData.access_token;
      if (!dcaToken) return null;

      try {
        const mintUrl = process.env.META_MINT_URL || "https://api.meta.ai/muse-code/key";
        const response = await proxyAwareFetch(mintUrl, {
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

        if (response.ok) {
          return await response.json();
        }
      } catch (err) {
        console.warn("Failed to mint Meta API key from DCA token:", err?.message);
      }
      return null;
    },
    mapTokens: (tokens, minted) => ({
      accessToken: minted?.api_key || tokens.access_token,
      apiKey: minted?.api_key || tokens.access_token,
      refreshToken: tokens.access_token,
      expiresIn: tokens.expires_in,
      email: minted?.user_email || undefined,
      displayName: minted?.user_full_name || undefined,
      providerSpecificData: {
        dcaToken: tokens.access_token,
        apiKey: minted?.api_key || "",
        baseUrl: minted?.base_url || "https://api.meta.ai/v1",
        subsTierName: minted?.subs_tier_name || "",
        subsTierId: minted?.subs_tier_id || "",
        isSubsActive: Boolean(minted?.is_subs_active),
      },
    }),
  },
  nous: {
    config: NOUS_CONFIG,
    flowType: "device_code",
    requestDeviceCode: async (config) => {
      const response = await proxyAwareFetch(config.deviceCodeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          scope: config.scope,
        }),
        provider: "nous",
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Nous device code request failed: ${error}`);
      }

      const data = await response.json();
      return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        verification_uri_complete: data.verification_uri_complete,
        expires_in: data.expires_in,
        interval: data.interval,
      };
    },
    pollToken: async (config, deviceCode) => {
      const response = await proxyAwareFetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.clientId,
          device_code: deviceCode,
        }),
        provider: "nous",
      });

      const bodyText = await response.text();
      let data;
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = { error: "invalid_response", error_description: bodyText.slice(0, 200) };
      }

      const pending =
        data?.error === "authorization_pending" ||
        data?.error === "slow_down";
      return {
        ok: response.ok || pending,
        data,
      };
    },
    postExchange: async (tokens) => {
      try {
        const response = await proxyAwareFetch(NOUS_CONFIG.agentKeyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${tokens.access_token}`,
          },
          body: JSON.stringify({
            min_ttl_seconds: 7200,
          }),
          provider: "nous",
        });

        if (!response.ok) {
          const error = await response.text().catch(() => "");
          console.warn(`[oauth] Nous agent key mint failed (${response.status}): ${error}`);
          return { agentKey: null };
        }

        const data = await response.json();
        return {
          agentKey: data.api_key || null,
          agentKeyId: data.key_id || null,
          agentKeyExpiresAt: data.expires_at || null,
          agentKeyExpiresIn: data.expires_in || null,
        };
      } catch (err) {
        console.warn(`[oauth] Nous agent key mint error: ${err?.message || err}`);
        return { agentKey: null };
      }
    },
    mapTokens: (tokens, extra) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      apiKey: extra?.agentKey || tokens.access_token,
      providerSpecificData: {
        inferenceBaseUrl: NOUS_CONFIG.inferenceBaseUrl,
        ...(extra?.agentKeyId ? { agentKeyId: extra.agentKeyId } : {}),
        ...(extra?.agentKeyExpiresAt ? { agentKeyExpiresAt: extra.agentKeyExpiresAt } : {}),
      },
    }),
  },

  "minimax-code": createMinimaxCodeProvider(MINIMAX_CODE_SITES.cn),
  "minimax-code-global": createMinimaxCodeProvider(MINIMAX_CODE_SITES.global),

  glm: {
  config: GLM_OAUTH_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const pollToken = crypto.randomBytes(32).toString("hex");
    const response = await proxyAwareFetch(config.cliInitUrl, {
      ...getOAuthFetchProfile("glm"), redirect: "error", signal: AbortSignal.timeout(30000),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pollToken}`,
      },
      body: JSON.stringify({ provider: config.providerId || "zai" }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ZCode OAuth init failed: ${error}`);
    }
    const payload = await response.json();
    if (!isSuccessCode(payload.code) || !payload.data) {
      throw new Error(payload.msg || "ZCode OAuth init returned no data");
    }
    const data = payload.data;
    if (!data.flow_id || !data.authorize_url) {
      throw new Error("ZCode OAuth init response missing flow_id/authorize_url");
    }
    return {
      device_code: data.flow_id,
      verification_uri: data.authorize_url,
      // expires_at is upstream-absolute; surface a relative deadline for the UI
      expires_in: relativeSeconds(data.expires_at) ?? 300,
      interval: data.poll_interval_sec || 3,
      _zcodePollToken: pollToken,
    };
  },
  pollToken: async (config, deviceCode, _codeVerifier, extraData) => {
    const pollToken = extraData?._zcodePollToken;
    if (!pollToken) {
      return {
        ok: true,
        data: {
          error: "access_denied",
          error_description: "Missing ZCode poll token — restart the login flow",
        },
      };
    }

    const response = await proxyAwareFetch(`${config.cliPollUrl}/${encodeURIComponent(deviceCode)}`, {
      ...getOAuthFetchProfile("glm"), redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${pollToken}` },
    });
    if (!response.ok) {
      return {
        ok: true,
        data: {
          error: "access_denied",
          error_description: `ZCode poll failed (HTTP ${response.status})`,
        },
      };
    }

    const payload = await response.json();
    if (!isSuccessCode(payload.code)) {
      return {
        ok: true,
        data: { error: "access_denied", error_description: payload.msg || "ZCode poll failed" },
      };
    }

    const data = payload.data || {};
    if (data.status === "pending") {
      return { ok: true, data: { error: "authorization_pending" } };
    }
    if (data.status === "failed") {
      return {
        ok: true,
        data: {
          error: "access_denied",
          error_description: "ZCode authorization failed or was cancelled",
        },
      };
    }
    if (data.status !== "ready") {
      return {
        ok: true,
        data: { error: "authorization_pending", error_description: `Unknown status: ${data.status}` },
      };
    }

    // ready payload nests the ZAI OAuth tokens under data[providerId] (see
    // apps/zcode-cli cli-oauth.ts parseReadyData): { status:"ready", token,
    // user, zai: { access_token, refresh_token? } }. Fall back to top-level
    // fields for resilience against payload drift.
    const providerData = data[config.providerId] || data[data.providerId] || {};
    const zaiAccessToken =
      providerData.access_token ||
      providerData.accessToken ||
      data.accessToken ||
      data.access_token;
    if (!zaiAccessToken) {
      return {
        ok: true,
        data: {
          error: "access_denied",
          error_description: "ZCode poll response missing access token",
        },
      };
    }

    // ready.accessToken is the Z.AI OAuth token — derive the coding-plan API key
    const { planApiKey, businessToken } = await resolveCodingPlanApiKey(config, zaiAccessToken);

    return {
      ok: true,
      data: {
        access_token: planApiKey,
        _zcodeJwtToken: data.token || "",
        _zaiBusinessToken: businessToken,
        _zaiRefreshToken:
          providerData.refresh_token || providerData.refreshToken || data.refresh_token || data.refreshToken || "",
        _zcodeUser: data.user || {},
      },
    };
  },
  mapTokens: (tokens) => {
    const user = tokens._zcodeUser || {};
    const displayName = user.name || user.email || null;
    return {
      accessToken: tokens.access_token,
      refreshToken: null,
      email: user.email || null,
      ...(displayName ? { displayName } : {}),
      providerSpecificData: {
        authMethod: "cli_poll",
        username: user.name || undefined,
        userId: user.user_id || undefined,
        zcodeJwtToken: tokens._zcodeJwtToken || undefined,
        zaiBusinessToken: tokens._zaiBusinessToken || undefined,
        ...(tokens._zaiRefreshToken ? { zaiRefreshToken: tokens._zaiRefreshToken } : {}),
      },
    };
  },
},

// Zed — RSA keypair native-app flow (NOT OAuth). prepareConfig generates a fresh
// keypair; buildAuthUrl returns the native_app_signin URL; exchangeToken decrypts
// the RSA-encrypted access token from the local callback. codeVerifier carries the
// encoded private key (see generateAuthData) so the proxy/paste paths can decrypt.
zed: {
  config: ZED_HOSTED_CONFIG,
  flowType: "authorization_code",
  callbackPath: "/",
  prepareConfig: async (config, meta) => {
    // native_app_port is the local callback port (derived from the proxy's
    // redirect_uri and passed via meta from the authorize step).
    const nativeAppPort = Number(meta?.nativeAppPort) || ZED_HOSTED_CONFIG.defaultNativeAppPort;
    const auth = createZedNativeAuthData(config, { nativeAppPort });
    return { ...config, ...auth };
  },
  buildAuthUrl: (config, redirectUri, state) => config.authUrl,
  exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta) => {
    // code = raw callback URL/query; codeVerifier = encoded private key verifier.
    const { userId, encryptedAccessToken } = parseZedCallbackPayload(code);
    const accessToken = decryptZedAccessToken(encryptedAccessToken, codeVerifier);
    // Prefer the system_id registered for this login attempt (threaded via
    // meta from register-session); fall back to the prepared config. Never
    // mint a fresh one here — exchangeTokens re-runs prepareConfig, which
    // would otherwise store a system_id unrelated to the zed.dev login.
    return { accessToken, userId, systemId: meta?.systemId || config.systemId };
  },
  postExchange: async (tokens) => {
    const credentials = {
      accessToken: tokens.accessToken,
      providerSpecificData: { userId: tokens.userId, systemId: tokens.systemId },
    };
    let userInfo = null;
    try {
      userInfo = await fetchZedAuthenticatedUser(credentials, { config: ZED_HOSTED_CONFIG });
    } catch { /* best-effort */ }
    const organizationId = resolveZedOrganizationId(credentials, userInfo);
    return {
      userInfo,
      organizationId,
      email: userInfo?.email || null,
      name: userInfo?.name || userInfo?.display_name || null,
    };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.accessToken,
    refreshToken: null,
    expiresIn: null,
    email: extra?.email || undefined,
    displayName: extra?.name || undefined,
    providerSpecificData: {
      authMethod: "oauth",
      userId: tokens.userId,
      systemId: tokens.systemId,
      organizationId: extra?.organizationId || "",
    },
  }),
},
};

/**
 * Get provider handler
 */
export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

/**
 * Get all provider names
 */
export function getProviderNames() {
  return Object.keys(PROVIDERS);
}

/**
 * Generate auth data for a provider
 * @param {object} [meta] - Provider-specific metadata (e.g. gitlab clientId/baseUrl)
 */
export async function generateAuthData(providerName, redirectUri, meta) {
  const provider = getProvider(providerName);
  const config = provider.prepareConfig
    ? await provider.prepareConfig(provider.config, meta || {})
    : provider.config;
  const { codeVerifier: pkceVerifier, codeChallenge, state } = generatePKCE(provider.pkceVerifierBytes);
  // Zed: codeVerifier carries the encoded RSA private key (from prepareConfig),
  // not a PKCE verifier — the key decrypts the browser-delivered token.
  const codeVerifier = config.privateKeyVerifier || pkceVerifier;

  let authUrl;
  if (provider.flowType === "device_code") {
    // Device code flow doesn't have auth URL upfront
    authUrl = null;
  } else if (provider.flowType === "authorization_code_pkce") {
    authUrl = provider.buildAuthUrl(config, redirectUri, state, codeChallenge, meta || {});
  } else {
    authUrl = provider.buildAuthUrl(config, redirectUri, state, undefined, meta || {});
  }

  // Bind state → verifier server-side so exchange can prove the flow started
  // here instead of trusting client-supplied values. Device-code flows never
  // redeem this entry; it expires via TTL.
  registerOAuthState({ state, provider: providerName, codeVerifier, redirectUri: redirectUri || null });

  return {
    authUrl,
    state,
    codeVerifier,
    codeChallenge,
    redirectUri,
    flowType: provider.flowType,
    fixedPort: provider.fixedPort,
    callbackPath: provider.callbackPath || "/callback",
    // Zed: surface the system_id embedded in the sign-in URL so the frontend
    // can thread it through register-session → exchange → stored connection
    // (exchangeTokens re-runs prepareConfig, which would otherwise mint a
    // different one). Absent for every other provider — purely additive.
    ...(config.systemId ? { systemId: config.systemId } : {}),
  };
}

/**
 * Exchange code for tokens
 * @param {object} [meta] - Provider-specific metadata (e.g. gitlab clientId/baseUrl)
 */
export async function exchangeTokens(providerName, code, redirectUri, codeVerifier, state, meta) {
  const provider = getProvider(providerName);
  const config = provider.prepareConfig
    ? await provider.prepareConfig(provider.config, meta || {})
    : provider.config;

  const tokens = await provider.exchangeToken(config, code, redirectUri, codeVerifier, state, meta || {});

  let extra = null;
  if (provider.postExchange) {
    extra = await provider.postExchange(tokens);
  }

  return provider.mapTokens(tokens, extra);
}

/**
 * Request device code (for device_code flow)
 */
export async function requestDeviceCode(providerName, codeChallenge, options) {
  const provider = getProvider(providerName);
  if (provider.flowType !== "device_code") {
    throw new Error(`Provider ${providerName} does not support device code flow`);
  }
  return await provider.requestDeviceCode(provider.config, codeChallenge, options || {});
}

/**
 * Poll for token (for device_code flow)
 * @param {string} providerName - Provider name
 * @param {string} deviceCode - Device code from requestDeviceCode
 * @param {string} codeVerifier - PKCE code verifier (optional for some providers)
 * @param {object} extraData - Extra data from device code response (e.g. clientId/clientSecret for Kiro)
 */
export async function pollForToken(providerName, deviceCode, codeVerifier, extraData) {
  const provider = getProvider(providerName);
  if (provider.flowType !== "device_code") {
    throw new Error(`Provider ${providerName} does not support device code flow`);
  }

  const result = await provider.pollToken(provider.config, deviceCode, codeVerifier, extraData);

  if (result.ok) {
    // For device code flows, success is only when we have an access token
    if (result.data.access_token) {
      // Call postExchange to get additional data (copilotToken, userInfo, etc.)
      let extra = null;
      if (provider.postExchange) {
        extra = await provider.postExchange(result.data);
      }
      const tokens = provider.mapTokens(result.data, extra);
      // Kiro IDC/Builder-ID tokens lack profileArn; resolve it to avoid 403
      if (providerName === "kiro" && !tokens.providerSpecificData?.profileArn) {
        const profileArn = await fetchKiroProfileArn(
          tokens.accessToken,
          tokens.providerSpecificData?.region,
        );
        if (profileArn) tokens.providerSpecificData.profileArn = profileArn;
      }
      return { success: true, tokens };
    } else {
      // Check if it's still pending authorization
      if (result.data.error === 'authorization_pending' || result.data.error === 'slow_down') {
        // This is not a failure, just still waiting
        return {
          success: false,
          error: result.data.error,
          errorDescription: result.data.error_description || result.data.message,
          pending: result.data.error === 'authorization_pending'
        };
      } else {
        // Actual error
        return {
          success: false,
          error: result.data.error || 'no_access_token',
          errorDescription: result.data.error_description || result.data.message || 'No access token received'
        };
      }
    }
  }

  return { success: false, error: result.data.error, errorDescription: result.data.error_description };
}

// Run-once guard across the process lifetime
let codexBackfillDone = false;

// Backfill email + chatgpt account info for existing codex OAuth connections missing them
export async function backfillCodexEmails() {
  if (codexBackfillDone) return;
  codexBackfillDone = true;
  try {
    const { getProviderConnections, updateProviderConnection } = await import("@/lib/db/index.js");
    const connections = await getProviderConnections();
    const targets = connections.filter((c) => {
      if (c.provider !== "codex" || c.authType !== "oauth" || !c.idToken) return false;
      const hasEmail = !!c.email;
      const hasAccountInfo = !!c.providerSpecificData?.chatgptAccountId;
      return !hasEmail || !hasAccountInfo;
    });
    for (const conn of targets) {
      const info = extractCodexAccountInfo(conn.idToken);
      if (!info.email && !info.chatgptAccountId) continue;
      const patch = {};
      if (!conn.email && info.email) patch.email = info.email;
      if (info.chatgptAccountId || info.chatgptPlanType) {
        patch.providerSpecificData = {
          ...(conn.providerSpecificData || {}),
          chatgptAccountId: info.chatgptAccountId,
          chatgptPlanType: info.chatgptPlanType,
        };
      }
      if (Object.keys(patch).length) {
        await updateProviderConnection(conn.id, patch);
      }
    }
  } catch (err) {
    codexBackfillDone = false;
    console.log("backfillCodexEmails failed:", err?.message || err);
  }
}
