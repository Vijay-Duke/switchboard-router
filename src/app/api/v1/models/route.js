// @ts-check
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases } from "@/lib/db/index.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { isModelCatalogDiscoveryRequest, MODEL_CATALOG_HEADER } from "@/lib/modelCatalogDiscovery";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels } from "open-sse/services/clinepassModels.js";
import { resolveProviderModels } from "open-sse/services/providerModels.js";
import {
  refreshImportedCursorCredentials,
  updateProviderCredentials,
} from "@/sse/services/tokenRefresh";
import { capabilitiesFromServiceKind } from "open-sse/providers/capabilities.js";
import {
  buildClaudeCatalogDisplayNameMap,
  formatClaudeCatalogDisplayName,
} from "@/shared/claudeCatalogDisplay.js";
import {
  encodeClaudeCatalogModelId,
  isClaudeFullCatalogRequest,
  isClaudeGatewayAlias,
  normalizeClaudeCatalogPickerLabels,
  readClaudeCatalogPickerLabelsFromHeaders,
  readClaudeCatalogSelectionFromHeaders,
} from "@/shared/claudeGateway.js";

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn, options = {}) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console, signal: options.signal });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn, options = {}) => {
    const result = await resolveQoderModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      email: conn.email,
      displayName: conn.displayName,
      providerSpecificData: conn.providerSpecificData || {}
    }, { signal: options.signal });
    if (!result?.models?.length) return null;
    return {
      models: result.models.map((m) => ({ id: m.id, name: m.name })),
    };
  },
  kimchi: async (conn, options = {}) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console, signal: options.signal });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn, options = {}) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      signal: options.signal,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn, options = {}) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    }, { signal: options.signal });
    return result?.models?.length ? { models: result.models } : null;
  }
};

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

async function fetchCompatibleModelIds(connection, externalSignal = null) {
  if (!connection?.apiKey) return [];

  const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return [];

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
    [MODEL_CATALOG_HEADER]: "1",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    if (url.endsWith("/messages/models")) {
      url = url.slice(0, -9);
    } else if (url.endsWith("/messages")) {
      url = `${url.slice(0, -9)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Forward caller signal into local controller when AbortSignal.any is unavailable.
    // This ensures the local timeout stays effective even with an external signal.
    if (externalSignal && typeof AbortSignal.any !== "function") {
      externalSignal.addEventListener("abort", () => { clearTimeout(timeoutId); controller.abort(externalSignal.reason); }, { once: true });
    }

    const signal = externalSignal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
        signal,
      });

      if (!response.ok) return [];

      const data = await response.json();
      const rawModels = parseOpenAIStyleModels(data);

      return Array.from(
        new Set(
          rawModels
            .map((model) => model?.id || model?.name || model?.model)
            .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
        )
      );
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 */
export async function buildModelsList(kindFilter, { signal = null, skipCompatibleDiscovery = false } = {}) {
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
  } catch (e) {
    console.log("Could not fetch providers, returning all models");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) => Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (signal?.aborted) break;
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }
  const cursorConnection = activeConnectionByProvider.get("cursor");
  if (cursorConnection) {
    activeConnectionByProvider.set(
      "cursor",
      await refreshImportedCursorCredentials(cursorConnection, { force: true }),
    );
  }
  const compatibleModelIdsByProvider = new Map();
  if (!skipCompatibleDiscovery) {
    const compatibleConnections = Array.from(activeConnectionByProvider.entries())
      .filter(([providerId]) =>
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId));
    await Promise.all(compatibleConnections.map(async ([providerId, connection]) => {
      compatibleModelIdsByProvider.set(
        providerId,
        await fetchCompatibleModelIds(connection, signal),
      );
    }));
  }
  const liveCatalogByProvider = new Map();
  const liveCatalogConnections = Array.from(activeConnectionByProvider.entries())
    .filter(([providerId]) =>
      providerMatchesKinds(providerId, kindFilter) &&
      !isOpenAICompatibleProvider(providerId) &&
      !isAnthropicCompatibleProvider(providerId));
  await Promise.all(liveCatalogConnections.map(async ([providerId, connection]) => {
    const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
    try {
      const live = liveResolver
        ? await liveResolver(connection, { signal })
        : await resolveProviderModels(connection, {
            signal,
            ...(providerId === "cursor" ? { log: console } : {}),
          });
      if (live?.models?.length) liveCatalogByProvider.set(providerId, live);
    } catch (error) {
      console.log(`Live model fetch failed for ${providerId}: ${error?.message || error}`);
    }
  }));

  const models = [];

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
      name: combo.name,
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    }
    models.push(entry);
  }

  // Claude Code gateway discovery intentionally accepts only Claude/Anthropic-
  // shaped IDs. Expose matching model aliases themselves (not just their
  // provider/model targets) so users can add arbitrary Switchboard-backed
  // models to Claude's picker without confusing provider parsing.
  if (kindFilter.includes(LLM_KIND)) {
    for (const alias of Object.keys(modelAliases || {})) {
      if (!isClaudeGatewayAlias(alias)) continue;
      models.push({
        id: alias,
        object: "model",
        owned_by: "switchboard-alias",
        display_name: `Switchboard · ${alias}`,
      });
    }
  }

  if (connections.length === 0) {
    // DB unavailable -> return static models, filtered by per-model kind
    const aliasToProviderId = Object.fromEntries(
      Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
    );
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = aliasToProviderId[alias] || alias;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      for (const model of providerModels) {
        if (!kindFilter.includes(modelKind(model))) continue;
        if (isDisabled(alias, model.id)) continue;
        models.push({
          id: `${alias}/${model.id}`,
          object: "model",
          owned_by: alias,
        });
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm")) continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;

      models.push({
        id: `${providerAlias}/${modelId}`,
        object: "model",
        owned_by: providerAlias,
      });
    }
  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (signal?.aborted) break;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      let liveModelKindById = new Map();
      let liveCapabilitiesById = new Map();

      let rawModelIds = hasExplicitEnabledModels
        ? Array.from(
            new Set(
              enabledModels.filter(
                (modelId) => typeof modelId === "string" && modelId.trim() !== "",
              ),
            ),
          )
        : providerModels.map((model) => model.id);

      if (isCompatibleProvider && !skipCompatibleDiscovery) {
        const discoveredIds = compatibleModelIdsByProvider.get(providerId) || [];
        if (discoveredIds.length > 0) rawModelIds = discoveredIds;
      }

      // Live catalogs are fetched concurrently above. Dynamic results replace
      // stored/static snapshots; discovery failure retains the fallback IDs.
      const live = liveCatalogByProvider.get(providerId);
      if (live?.models?.length) {
        rawModelIds = live.models.map((m) => m.id);
        liveModelKindById = new Map(
          live.models
            .filter((m) => m?.id)
            .map((m) => [m.id, modelKind(m)])
        );
        liveCapabilitiesById = new Map(
          live.models
            .filter((m) => m?.id && m.capabilities)
            .map((m) => [m.id, m.capabilities])
        );
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer custom/live metadata, then static, then ID heuristics.
        const customKind = customModelKindById.get(modelId);
        const liveKind = liveModelKindById.get(modelId);
        const kind = customKind || liveKind || staticModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        const caps = liveCapabilitiesById.get(modelId) || capabilitiesFromServiceKind(customKind || liveKind);
        if (caps) model.capabilities = caps;
        models.push(model);
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        });
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        });
      }
    }
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  return dedupedModels;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    const models = await buildModelsList([LLM_KIND], {
      signal: request?.signal,
      skipCompatibleDiscovery: isModelCatalogDiscoveryRequest(request),
    });
    let data = models;
    if (isClaudeFullCatalogRequest(request?.headers)) {
      const selectedModelIds = readClaudeCatalogSelectionFromHeaders(request?.headers);
      const selectedModels = new Set(selectedModelIds);
      const customLabels = normalizeClaudeCatalogPickerLabels(
        readClaudeCatalogPickerLabelsFromHeaders(request?.headers),
        selectedModelIds,
      );
      const displayNames = buildClaudeCatalogDisplayNameMap(selectedModelIds);
      const catalogModels = [];
      for (const model of models) {
        if (!selectedModels.has(model.id)) continue;
        const displayName = customLabels[model.id]
          || formatClaudeCatalogDisplayName(model.id, displayNames);
        catalogModels.push({
          id: encodeClaudeCatalogModelId(model.id),
          object: "model",
          owned_by: "switchboard-catalog",
          display_name: displayName,
          description: model.id,
        });
      }
      data = catalogModels;
    }
    return Response.json({ object: "list", data }, {
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
