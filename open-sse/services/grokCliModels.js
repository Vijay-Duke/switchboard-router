import { refreshProviderCredentials } from "./oauthCredentialManager.js";
import { normalizeModels } from "./providerModels.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  GROK_CLI_BASE_URL,
  GROK_CLI_FETCH_PROFILE,
  GROK_CLI_MODEL,
  buildGrokCliApiHeaders,
} from "../config/grokCli.js";

function entries(data) {
  const value = Array.isArray(data) ? data : data?.data ?? data?.models ?? data?.results ?? [];
  if (Array.isArray(value)) return value.map((item) => [null, item]);
  return value && typeof value === "object" ? Object.entries(value) : [];
}

export function parseGrokCliModels(data) {
  const models = entries(data).map(([key, raw]) => {
    const item = typeof raw === "string" ? { id: raw } : raw;
    if (!item || typeof item !== "object") return null;
    const id = String(item.id ?? item.model_id ?? item.modelId ?? item.model ?? item.slug ?? key ?? "").trim();
    if (!id) return null;
    return { ...item, id };
  }).filter(Boolean);

  return normalizeModels(models).map((model) => {
    const contextLength = Number(model.context_length ?? model.contextLength ?? model.context_window ?? model.contextWindow);
    const maxOutputTokens = Number(model.max_output_tokens ?? model.maxOutputTokens);
    if (Number.isFinite(contextLength) && contextLength > 0) model.contextLength = contextLength;
    if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) model.maxOutputTokens = maxOutputTokens;
    if (model.id === GROK_CLI_MODEL) {
      model.contextLength ||= 500000;
      model.maxOutputTokens ||= 64000;
    }
    return model;
  });
}

export async function resolveGrokCliModels(credentials, options = {}) {
  const {
    fetchFn = proxyAwareFetch,
    log = console,
    proxyOptions = null,
    signal,
    onCredentialsRefreshed,
  } = options;
  if (!credentials?.accessToken) return { models: [], warning: "Grok CLI access token is missing." };

  const request = (accessToken) => fetchFn(`${GROK_CLI_BASE_URL}/models`, {
    method: "GET",
    headers: buildGrokCliApiHeaders(accessToken, credentials.providerSpecificData || {}),
    signal,
    ...GROK_CLI_FETCH_PROFILE,
  }, proxyOptions);

  try {
    let response = await request(credentials.accessToken);
    if ((response.status === 401 || response.status === 403) && credentials.refreshToken) {
      const refreshed = await refreshProviderCredentials("grok-cli", credentials, log, proxyOptions);
      if (refreshed?.accessToken) {
        try { await onCredentialsRefreshed?.(refreshed); } catch (error) {
          log?.warn?.("Grok CLI credential persistence failed", error);
        }
        response = await request(refreshed.accessToken);
      }
    }
    if (!response.ok) return { models: [], warning: `Grok CLI model discovery failed (${response.status}).` };
    const models = parseGrokCliModels(await response.json());
    return models.length
      ? { models }
      : { models: [], warning: "Grok CLI returned no selectable models." };
  } catch (error) {
    return { models: [], warning: `Grok CLI model discovery failed: ${error.message}` };
  }
}
