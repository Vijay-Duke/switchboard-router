import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { getExecutor } from "../executors/index.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { withCredentialRefreshLock } from "../services/oauthCredentialManager.js";
import { getEmbeddingAdapter } from "./embeddingProviders/index.js";
import { assertPublicUrlResolved } from "../utils/ssrfGuard.js";
import { getOpenSseDeps } from "../runtimeDeps.js";
import { proxyAwareFetch, proxyOptionsFromCredentials } from "../utils/proxyFetch.js";
import { PROVIDERS, PROVIDER_MEDIA } from "../providers/index.js";

// Local input caps: fail fast instead of surfacing upstream 400s / OOMs.
const EMBEDDINGS_MAX_BATCH = 256;
const EMBEDDINGS_MAX_TOTAL_CHARS = 1024 * 1024;

function embeddingTransport(provider) {
  const transport = PROVIDERS[provider] || {};
  const config = PROVIDER_MEDIA[provider]?.embeddingConfig || {};
  return {
    identity: config.identity || transport.identity || "openai-node",
    format: config.format || transport.format || "openai",
  };
}
/**
 * Core embeddings handler — orchestrator only. Provider-specific URL/headers/body/normalize
 * live in `./embeddingProviders/{id}.js`.
 *
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleEmbeddingsCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  abortSignal,
}) {
  const { provider, model } = modelInfo;
  const transport = embeddingTransport(provider);
  const proxyOptions = proxyOptionsFromCredentials(credentials);

  // Validate input
  const input = body.input;
  if (input === undefined) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }
  if (typeof input !== "string" && !Array.isArray(input)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "input must be a string or array of non-empty strings");
  }
  const items = typeof input === "string" ? [input] : input;
  if (items.length === 0 || items.length > EMBEDDINGS_MAX_BATCH) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `input must contain 1-${EMBEDDINGS_MAX_BATCH} items`);
  }
  if (items.some((item) => typeof item !== "string" || !item.trim())) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "input must be a non-empty string or array of non-empty strings");
  }
  if (items.reduce((total, item) => total + item.length, 0) > EMBEDDINGS_MAX_TOTAL_CHARS) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `input exceeds ${EMBEDDINGS_MAX_TOTAL_CHARS} total characters`);
  }

  const adapter = getEmbeddingAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support embeddings.`
    );
  }

  const ctx = { input };
  let url;
  let headers;
  let requestBody;
  try {
    url = adapter.buildUrl(model, credentials, ctx);
    headers = adapter.buildHeaders(credentials, ctx);
    requestBody = adapter.buildBody(model, {
      input,
      encoding_format: body.encoding_format || "float",
      dimensions: body.dimensions,
    });
  } catch (error) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message || "Invalid embeddings configuration");
  }

  log?.debug?.("EMBEDDINGS", `${provider.toUpperCase()} | ${model} | input_type=${Array.isArray(input) ? `array[${input.length}]` : "string"}`);

  let ssrfAllowHosts = null;
  try {
    ssrfAllowHosts = (await getOpenSseDeps().getSettings?.())?.ssrfAllowHosts || null;
  } catch {
    // settings unavailable — fall back to default-deny
  }

  let providerResponse;
  try {
    if (provider !== "selfhosted-embedding") await assertPublicUrlResolved(url, ssrfAllowHosts);
    providerResponse = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      redirect: "error",
      signal: abortSignal,
      identity: transport.identity,
      provider,
      format: transport.format,
    }, proxyOptions);
  } catch (error) {
    if (error?.name === "AbortError" || abortSignal?.aborted) {
      return createErrorResult(499, "Embeddings request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("EMBEDDINGS", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 — try token refresh (skip for noAuth providers)
  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    const newCredentials = await refreshWithRetry(async () => {
      const result = await withCredentialRefreshLock(provider, credentials, () => executor.refreshCredentials(credentials, log));
      // aa0448f7: rotate refresh_token between retries — a consumed RT must not
      // be replayed on the next attempt or the provider revokes the session.
      if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
        if (result.accessToken) credentials.accessToken = result.accessToken;
        credentials.refreshToken = result.refreshToken;
      }
      return result;
    }, 3, log);

    if (newCredentials?.accessToken || newCredentials?.apiKey) {
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for embeddings`);
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);

      try {
        const retryHeaders = adapter.buildHeaders(credentials, ctx);
        const retryUrl = adapter.buildUrl(model, credentials, ctx);
        if (provider !== "selfhosted-embedding") await assertPublicUrlResolved(retryUrl, ssrfAllowHosts);
        await providerResponse.body?.cancel?.().catch?.(() => {});
        providerResponse = await proxyAwareFetch(retryUrl, {
          method: "POST",
          headers: retryHeaders,
          body: JSON.stringify(requestBody),
          redirect: "error",
          signal: abortSignal,
          identity: transport.identity,
          provider,
          format: transport.format,
        }, proxyOptions);
      } catch (error) {
        if (error?.name === "AbortError" || abortSignal?.aborted) {
          return createErrorResult(499, "Embeddings request aborted");
        }
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("EMBEDDINGS", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  const normalized = adapter.normalize(responseBody, model);
  log?.debug?.("EMBEDDINGS", `Success | usage=${JSON.stringify(normalized.usage || {})}`);

  return {
    success: true,
    response: new Response(JSON.stringify(normalized), {
      headers: {
        "Content-Type": "application/json",
      },
    }),
  };
}
