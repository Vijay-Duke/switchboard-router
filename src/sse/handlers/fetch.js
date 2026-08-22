import "../initOpenSseDeps.js";
import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { getSettings, getCombos } from "@/lib/db/index.js";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { handleFetchCore } from "open-sse/handlers/fetch/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { authorizeClientKeyRequest, runWithClientKeyLease } from "../services/clientKeyPolicy.js";
import { getFetchCache } from "@/lib/db/repos/fetchCacheRepo.js";
import {
  buildFetchCacheKey, cacheLiveResponse, fetchCacheHitResponse, getFetchCacheTtlMs,
} from "../utils/fetchCache.js";
import { withConnectionInFlight } from "../services/connectionInFlight.js";

/**
 * Handle web fetch (URL extraction) request for the SSE/Next.js server.
 * Provider IS the model. Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleFetch(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("FETCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    log.warn("FETCH", "Invalid JSON body shape");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const reqUrl = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webFetch)
  const providerInput = body.provider || body.model;
  const targetUrl = body.url;
  const format = body.format;
  const maxCharacters = body.max_characters;

  log.request("POST", `${reqUrl.pathname} | ${providerInput}`);

  const settings = await getSettings();
  const combos = providerInput ? await getCombos() : [];
  const comboModels = providerInput ? getComboModelsFromData(providerInput, combos) : null;
  const auth = await authorizeClientKeyRequest({
    settings,
    rawKey: extractApiKey(request),
    request,
    target: { kind: comboModels ? "combo" : "model", id: providerInput },
  });
  if (!auth.ok) return auth.response;
  return runWithClientKeyLease(auth.lease, async () => {
    const { clientKeyId } = auth;

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("FETCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  if (!targetUrl || typeof targetUrl !== "string") {
    log.warn("FETCH", "Missing url");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: url");
  }

  // Validate URL format
  try {
    new URL(targetUrl);
  } catch {
    log.warn("FETCH", "Invalid URL", { url: targetUrl });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid URL format");
  }

  // SSRF guard: reject internal/private/metadata targets
  try {
    assertPublicUrl(targetUrl);
  } catch (err) {
    log.warn("FETCH", "Blocked URL", { url: targetUrl });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, err.message);
  }

  let ttlMs = 0;
  try { ttlMs = getFetchCacheTtlMs(settings); } catch {}
  let cache = null;
  if (ttlMs > 0) {
    try {
      cache = {
        cacheKey: buildFetchCacheKey(body, providerInput),
        kind: "fetch",
        url: targetUrl.trim(),
        ttlMs,
      };
    } catch {}
  }
  if (cache) {
    try {
      const hit = await getFetchCache(cache.cacheKey);
      if (hit) {
        log.info("FETCH", `cache hit ${cache.url}`);
        return fetchCacheHitResponse(hit);
      }
    } catch {}
  }
  const cacheResponse = async (response) => cache ? cacheLiveResponse(response, cache, log) : response;

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("FETCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return cacheResponse(await handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m, callOpts) => handleSingleProviderFetch(b, m, request, clientKeyId, settings, callOpts),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit,
      abortSignal: request?.signal || null,
    }));
  }

  return cacheResponse(await handleSingleProviderFetch(
    body, providerInput, request, clientKeyId, settings, { signal: request?.signal || null },
  ));
  });
}

async function handleSingleProviderFetch(body, providerInput, request, clientKeyId, settings, callOpts = null) {
  const targetUrl = body.url;
  const format = body.format;
  const maxCharacters = body.max_characters;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("FETCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.fetchConfig;
  if (!providerConfig) {
    log.warn("FETCH", "Provider does not support web fetch", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web fetch`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // No-auth fetch path (kept for parity though no current fetch provider sets noAuth)
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleFetchCore({
      url: targetUrl,
      format,
      maxCharacters,
      provider: resolvedProvider.id,
      providerConfig,
      credentials: null,
      log,
      abortSignal: callOpts?.signal || request?.signal || null,
    });
    if (result.success) {
      return new Response(JSON.stringify(result.data), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed");
  }

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(providerId, excludeConnectionIds, null, {
      clientKeyId,
    });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("FETCH", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${providerId}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
      }
      log.warn("FETCH", "No more accounts available", { provider: providerId });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

    const attempt = await withConnectionInFlight({
      provider: providerId,
      model: providerId,
      connectionId: credentials.connectionId,
    }, async () => {
      const result = await handleFetchCore({
        clientKeyId,
        url: targetUrl,
        format,
        maxCharacters,
        provider: resolvedProvider.id,
        providerConfig,
        credentials: refreshedCredentials,
        log,
        abortSignal: callOpts?.signal || request?.signal || null,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            accessToken: newCreds.accessToken,
            refreshToken: newCreds.refreshToken,
            providerSpecificData: newCreds.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials);
        }
      });

      if (result.success) {
        return new Response(JSON.stringify(result.data), {
          headers: { "Content-Type": "application/json" }
        });
      }

      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId,
        result.status,
        result.error,
        providerId,
      );
      if (shouldFallback) {
        return { retry: true, error: result.error, status: result.status };
      }
      return {
        finalResponse: errorResponse(
          result.status || HTTP_STATUS.BAD_GATEWAY,
          result.error || "Fetch failed",
        ),
      };
    });

    if (attempt instanceof Response) return attempt;
    if (attempt.finalResponse) return attempt.finalResponse;
    log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${attempt.status}), trying fallback`);
    excludeConnectionIds.add(credentials.connectionId);
    lastError = attempt.error;
    lastStatus = attempt.status;
  }
}
