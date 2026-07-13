import REGISTRY from "../providers/registry/index.js";
import { decodeMessage } from "../utils/cursorProtobuf.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const CACHE_MAX_SIZE = 256;
const catalogCache = new Map();
const inFlight = new Map();

function registryEntry(providerId) {
  return REGISTRY.find((entry) => entry.id === providerId);
}

function cacheKey(connection) {
  // Never retain credentials or personal data in process-wide cache keys.
  // Ephemeral calls are intentionally uncached because their credentials may
  // belong to different accounts.
  return connection?.id || null;
}

function modelsUrlFromBase(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/$/, "");
  if (path.endsWith("/models")) return url.toString();
  if (path.endsWith("/chat/completions")) {
    url.pathname = path.slice(0, -"/chat/completions".length) + "/models";
    return url.toString();
  }
  if (path.endsWith("/messages")) {
    url.pathname = path.slice(0, -"/messages".length) + "/models";
    return url.toString();
  }
  if (path.endsWith("/responses")) {
    url.pathname = path.slice(0, -"/responses".length) + "/models";
    return url.toString();
  }
  if (path.endsWith("/api/chat")) {
    url.pathname = path.slice(0, -"/api/chat".length) + "/api/tags";
    return url.toString();
  }

  url.pathname = `${path}/models`;
  return url.toString();
}

function getDiscoveryConfig(entry) {
  const fetcher = entry?.modelsFetcher;
  if (fetcher?.url) {
    return {
      url: fetcher.url,
      method: fetcher.method || "GET",
      type: fetcher.type || "openai",
      body: fetcher.body,
    };
  }

  // Cursor already declares this endpoint in its OAuth config. Keep that
  // declaration authoritative instead of duplicating a second URL.
  if (entry?.id === "cursor" && entry.oauth?.apiEndpoint && entry.oauth?.modelsEndpoint) {
    return {
      url: `${entry.oauth.apiEndpoint.replace(/\/$/, "")}${entry.oauth.modelsEndpoint}`,
      method: "POST",
      type: "cursor-unary-protobuf",
      body: new Uint8Array(0),
    };
  }

  try {
    const url = modelsUrlFromBase(entry?.transport?.baseUrl);
    return url ? { url, method: "GET", type: "openai" } : null;
  } catch {
    return null;
  }
}

function authToken(connection) {
  return connection?.providerSpecificData?.copilotToken
    || connection?.providerSpecificData?.apiKey
    || connection?.accessToken
    || connection?.apiKey
    || null;
}

function buildHeaders(entry, connection, type) {
  const token = authToken(connection);
  if (type === "cursor-unary-protobuf") {
    return {
      "Content-Type": "application/proto",
      // Next's server fetch omits framing for a zero-byte typed-array body
      // unless the length is explicit; Cursor otherwise sees premature EOF.
      "Content-Length": "0",
      "Connect-Protocol-Version": "1",
      "x-ghost-mode": connection?.providerSpecificData?.ghostMode === false ? "false" : "true",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  const headers = {
    ...(entry?.transport?.headers || {}),
    "Content-Type": "application/json",
  };
  if (!token) return headers;

  const isClaude = entry?.transport?.format === "claude";
  if (isClaude) headers["x-api-key"] = token;
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

function modelId(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.id || value.slug || value.model || value.name || "").trim();
}

function normalizeModels(rawModels) {
  const models = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    const id = modelId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (typeof raw === "string") {
      models.push({ id, name: id });
      continue;
    }
    models.push({
      ...raw,
      id,
      name: raw.display_name || raw.displayName || raw.name || id,
    });
  }
  return models;
}

function parseJsonModels(data) {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
}

function parseCursorModels(buffer) {
  const models = [];
  const fields = decodeMessage(buffer);
  for (const field of fields.get(1) || []) {
    if (field.wireType !== 2) continue;
    const details = decodeMessage(field.value);
    const readString = (fieldNumber) => {
      const value = details.get(fieldNumber)?.find((entry) => entry.wireType === 2)?.value;
      return value ? Buffer.from(value).toString("utf8").trim() : "";
    };
    const id = readString(1);
    if (!id || !/^[a-z0-9][a-z0-9._:/+~-]{1,}$/i.test(id)) continue;
    const displayModelId = readString(3);
    const name = readString(4) || readString(5) || displayModelId || id;
    models.push({ id, name, ...(displayModelId ? { displayModelId } : {}) });
  }
  return normalizeModels(models);
}

async function readBinaryResponse(response) {
  if (typeof response.bytes === "function") {
    return Buffer.from(await response.bytes());
  }
  if (typeof response.arrayBuffer === "function") {
    return Buffer.from(await response.arrayBuffer());
  }
  if (typeof response.buffer === "function") {
    return Buffer.from(await response.buffer());
  }
  if (response.body) {
    const chunks = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error("Provider response does not expose a binary body reader");
}

async function fetchCatalog(connection, entry, config, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const signal = options.signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([options.signal, controller.signal])
    : options.signal || controller.signal;

  try {
    const response = await fetch(config.url, {
      method: config.method,
      headers: buildHeaders(entry, connection, config.type),
      ...(config.body !== undefined ? { body: config.body } : {}),
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      options.log?.warn?.("Provider model discovery request failed", {
        provider: connection?.provider,
        status: response.status,
        statusText: response.statusText,
      });
      try { await response.body?.cancel?.(); } catch {}
      return null;
    }

    if (config.type === "cursor-unary-protobuf") {
      return parseCursorModels(await readBinaryResponse(response));
    }
    return normalizeModels(parseJsonModels(await response.json()));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Discover the models available to a provider connection.
 *
 * This is deliberately best-effort: a provider can omit /models, require a
 * provider-specific endpoint, or be temporarily unavailable. Callers should
 * retain the registry catalog when this returns null.
 */
export async function resolveProviderModels(connection, options = {}) {
  const providerId = connection?.provider;
  const entry = registryEntry(providerId);
  const config = getDiscoveryConfig(entry);
  if (!entry || !config) return null;

  const key = cacheKey(connection);
  const now = Date.now();
  if (key && !options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      catalogCache.delete(key);
      catalogCache.set(key, cached);
      return { models: cached.models };
    }
    if (cached) catalogCache.delete(key);
    if (inFlight.has(key)) return inFlight.get(key);
  }

  let request;
  request = fetchCatalog(connection, entry, config, options)
    .then((models) => {
      if (!models?.length) return null;
      if (key) {
        catalogCache.delete(key);
        catalogCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, models });
        while (catalogCache.size > CACHE_MAX_SIZE) {
          catalogCache.delete(catalogCache.keys().next().value);
        }
      }
      return { models };
    })
    .catch((error) => {
      options.log?.warn?.("Provider model discovery failed", {
        provider: providerId,
        error: error?.message || String(error),
      });
      return null;
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });

  if (key) inFlight.set(key, request);
  return request;
}

export function clearProviderModelCache() {
  catalogCache.clear();
  inFlight.clear();
}

export { modelsUrlFromBase, normalizeModels, parseCursorModels };
