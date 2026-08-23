import { refreshProviderCredentials } from "./oauthCredentialManager.js";
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
  const models = [];
  const seen = new Set();
  for (const [key, raw] of entries(data)) {
    const item = typeof raw === "string" ? { id: raw } : raw;
    if (!item || typeof item !== "object") continue;
    const id = String(item.id ?? item.model_id ?? item.modelId ?? item.model ?? item.slug ?? key ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model = { ...item, id, name: item.display_name ?? item.displayName ?? item.name ?? id };
    const contextLength = Number(item.context_length ?? item.contextLength ?? item.context_window ?? item.contextWindow);
    const maxOutputTokens = Number(item.max_output_tokens ?? item.maxOutputTokens);
    if (Number.isFinite(contextLength) && contextLength > 0) model.contextLength = contextLength;
    if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) model.maxOutputTokens = maxOutputTokens;
    if (id === GROK_CLI_MODEL) {
      model.contextLength ||= 500000;
      model.maxOutputTokens ||= 64000;
    }
    models.push(model);
  }
  return models;
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
      const refreshed = await refreshProviderCredentials("grok-cli", credentials, log);
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
