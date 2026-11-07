// @ts-check
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  getProviderAlias,
  resolveProviderId,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases } from "@/lib/db/index.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { isModelCatalogDiscoveryRequest, MODEL_CATALOG_HEADER } from "@/lib/modelCatalogDiscovery";
import {
  buildCanonicalDisabledModelSet,
  buildServedProviderModels,
  isCanonicalModelDisabled,
} from "@/shared/utils/providerCustomModels.js";
import { discoverConnectionModels } from "@/lib/providerModelDiscovery";
import { capabilitiesFromServiceKind, effortCapabilitiesForModelId, resolveEffortCapabilities, unionEffortCapabilities } from "open-sse/providers/capabilities.js";
import { effortCapabilitiesFromThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { MAX_COMBO_DEPTH } from "open-sse/config/runtimeConfig.js";
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

// Per-connection discovery budget. A slow upstream must not stall /v1/models;
// on timeout the provider falls back to its static + saved models.
const DISCOVERY_TIMEOUT_MS = 10 * 1000;

async function discoverWithTimeout(connection, signal) {
  if (signal?.aborted) return null;
  let timer;
  let onAbort;
  try {
    const result = await Promise.race([
      discoverConnectionModels(connection),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS);
        onAbort = () => resolve(null);
        signal?.addEventListener?.("abort", onAbort, { once: true });
      }),
    ]);
    return result && "models" in result ? result : null;
  } catch (error) {
    console.log(`Live model fetch failed for ${connection?.provider}: ${error?.message || error}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener?.("abort", onAbort);
  }
}

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  for (const key of ["data", "models", "results"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return null;
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
  video: "video",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

async function fetchCompatibleModelIds(connection, externalSignal = null) {
  if (!connection?.apiKey) return null;

  const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return null;

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
    return null;
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

      if (!response.ok) return null;

      const data = await response.json();
      const rawModels = parseOpenAIStyleModels(data);
      if (!rawModels) return null;

      const modelIds = Array.from(
        new Set(
          rawModels
            .map((model) => model?.id || model?.name || model?.model)
            .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
        )
      );
      // Relay per-model capability objects when the upstream provides them so
      // explicit upstream restrictions (e.g. effort.supported: false) survive
      // discovery instead of being replaced by static fallbacks downstream.
      const capsById = new Map();
      for (const model of rawModels) {
        const rawId = model?.id || model?.name || model?.model;
        if (typeof rawId === "string" && rawId.trim() !== ""
            && model && typeof model === "object"
            && model.capabilities && typeof model.capabilities === "object") {
          capsById.set(rawId.trim(), model.capabilities);
        }
      }
      // A nonempty payload with no usable model IDs is malformed discovery,
      // not an authoritative declaration that this provider has no models.
      return rawModels.length > 0 && modelIds.length === 0 ? null : { ids: modelIds, capsById };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return null;
  }
}

// Look up relayed compatible-upstream capabilities by bare or aliased id:
// upstreams may use either form.
function compatCapsForModel(capsById, outputAlias, staticAlias, providerId, modelId) {
  if (!capsById) return null;
  const keys = [modelId, `${outputAlias}/${modelId}`, `${staticAlias}/${modelId}`, `${providerId}/${modelId}`];
  for (const key of keys) {
    if (capsById.has(key)) return capsById.get(key);
  }
  return null;
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
  let connectionsFetchFailed = false;
  try {
    connections = await getProviderConnections();
  } catch (e) {
    connectionsFetchFailed = true;
    console.log("Could not fetch providers, returning all models");
  }
  // Active-only view for routing availability; the unfiltered list still
  // distinguishes "DB down" (fail open) from "all connections disabled"
  // (stop advertising — Switchboard#models-advertise).
  const activeConnections = connections.filter((c) => c.isActive !== false);

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
  const disabledCanonicalByAlias = new Map(
    Object.entries(disabledByAlias).map(([alias, modelIds]) => [
      alias,
      buildCanonicalDisabledModelSet(modelIds, alias),
    ]),
  );
  const isDisabled = (alias, modelId) => {
    // Dashboard/probe imports can store flags under either the public alias
    // or registry id. Consult both without changing nested upstream model ids.
    const providerId = resolveProviderId(alias);
    const storageKeys = new Set([
      alias,
      providerId,
      getProviderAlias(providerId),
      PROVIDER_ID_TO_ALIAS[providerId],
    ].filter(Boolean));
    return [...storageKeys].some((key) => {
      const disabledIds = disabledCanonicalByAlias.get(key);
      return disabledIds
        ? isCanonicalModelDisabled(disabledIds, modelId, key)
        : false;
    });
  };

  const activeConnectionByProvider = new Map();
  for (const conn of activeConnections) {
    if (signal?.aborted) break;
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }
  // Compatible upstreams are fetched only to relay per-model capabilities;
  // which models are served comes from the saved dashboard selection.
  const compatibleCatalogByProvider = new Map();
  if (!skipCompatibleDiscovery) {
    const compatibleConnections = Array.from(activeConnectionByProvider.entries())
      .filter(([providerId]) =>
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId));
    await Promise.all(compatibleConnections.map(async ([providerId, connection]) => {
      compatibleCatalogByProvider.set(
        providerId,
        await fetchCompatibleModelIds(connection, signal),
      );
    }));
  }
  // Same discovery the provider dashboard renders, so /v1/models serves exactly
  // the models the dashboard lists as enabled.
  const discoveredByProvider = new Map();
  const discoveryConnections = Array.from(activeConnectionByProvider.entries())
    .filter(([providerId]) =>
      providerMatchesKinds(providerId, kindFilter) &&
      !isOpenAICompatibleProvider(providerId) &&
      !isAnthropicCompatibleProvider(providerId));
  await Promise.all(discoveryConnections.map(async ([providerId, connection]) => {
    const discovered = await discoverWithTimeout(connection, signal);
    if (discovered) discoveredByProvider.set(providerId, discovered);
  }));

  const models = [];

  // Availability: when real connection data exists, stop advertising entries
  // whose every target provably belongs to a provider with no active
  // connection. Undetermined prefixes (custom nodes, bare names) stay visible —
  // fail-open, matching the route's live-catalog fallback philosophy. With no
  // connection data (DB unavailable) nothing is hidden.
  const isModelStringUnavailable = (modelStr) => {
    if (typeof modelStr !== "string") return false;
    const slash = modelStr.indexOf("/");
    if (slash <= 0) return false; // bare name: alias/combo target — undetermined
    const prefix = modelStr.slice(0, slash);
    const resolvedProvider = resolveProviderId(prefix);
    if (!resolvedProvider || !AI_PROVIDERS[resolvedProvider]) return false;
    return !activeConnectionByProvider.has(resolvedProvider);
  };
  const hasConnectionsData = !connectionsFetchFailed;

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    // A combo with zero routable members is dead weight in the list; a combo
    // with any live (or undetermined) member keeps serving fallback semantics.
    if (hasConnectionsData) {
      const members = Array.isArray(combo.models) ? combo.models : [];
      if (members.length > 0 && members.every(isModelStringUnavailable)) continue;
    }
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
    for (const [alias, target] of Object.entries(modelAliases || {})) {
      if (!isClaudeGatewayAlias(alias)) continue;
      if (hasConnectionsData && isModelStringUnavailable(target)) continue;
      if (typeof target === "string" && target.includes("/")) {
        const slash = target.indexOf("/");
        const targetPrefix = target.slice(0, slash);
        const targetModelId = target.slice(slash + 1);
        const targetConnection = activeConnections.find((connection) =>
          connection.providerSpecificData?.prefix === targetPrefix);
        if (isDisabled(targetPrefix, targetModelId)
          || (targetConnection && isDisabled(targetConnection.provider, targetModelId))) continue;
      }
      models.push({
        id: alias,
        object: "model",
        owned_by: "switchboard-alias",
        display_name: `Switchboard · ${alias}`,
      });
    }
  }

  if (connectionsFetchFailed) {
    // DB unavailable -> return static models, filtered by per-model kind
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = resolveProviderId(alias);
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
      if (!modelId || isDisabled(providerAlias, modelId)) continue;

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
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      const compatCatalog = compatibleCatalogByProvider.get(providerId);
      const compatCapsById = compatCatalog && compatCatalog.capsById instanceof Map
        ? compatCatalog.capsById
        : null;

      // Serve exactly what the provider's dashboard page lists as enabled.
      const rows = buildServedProviderModels({
        providerId,
        staticModels: isCompatibleProvider ? [] : (PROVIDER_MODELS[staticAlias] || []),
        discoveredModels: discoveredByProvider.get(providerId)?.models || [],
        customModels,
        modelAliases,
        isCompatible: isCompatibleProvider,
      });
      const stripPrefix = (modelId) => {
        for (const prefix of [outputAlias, staticAlias, providerId]) {
          if (modelId.startsWith(`${prefix}/`)) return modelId.slice(prefix.length + 1);
        }
        return modelId;
      };

      for (const row of rows) {
        const modelId = stripPrefix(row.id);
        if (!modelId) continue;
        const customKind = row.source === "custom" ? row.kind : null;
        const liveKind = row.source === "live" ? row.kind : null;
        const kind = row.kind;
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (row.storageAlias && (isDisabled(row.storageAlias, row.id) || isDisabled(row.storageAlias, modelId))) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        // Precedence: live catalog capabilities > relayed compatible-upstream
        // capabilities > generic service-kind fallback. Static effort levels
        // fill in only when none of those advertise an effort block.
        const relayedCaps = compatCapsForModel(compatCapsById, outputAlias, staticAlias, providerId, modelId);
        const kindCaps = capabilitiesFromServiceKind(customKind || liveKind);
        const liveCaps = row.capabilities
          || (relayedCaps || kindCaps ? { ...(kindCaps || {}), ...(relayedCaps || {}) } : null);
        const registryEffort = effortCapabilitiesFromThinkingLevels(providerId, modelId);
        const staticCaps = effortCapabilitiesForModelId(modelId)
          || registryEffort;
        const effortCaps = resolveEffortCapabilities(liveCaps, staticCaps);
        const caps = effortCaps ? { ...(liveCaps || {}), ...effortCaps } : liveCaps;
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
    // OpenAI list entries carry `created` (unix seconds); default to 0 so
    // strict clients never see a missing field.
    if (typeof model.created !== "number") model.created = 0;
    dedupedModels.push(model);
  }

  // Combos and gateway aliases are emitted before their members/targets, so
  // their effort metadata can only be resolved once every provider entry
  // exists. A combo advertises the UNION of its members' levels (routing
  // picks one member at a time and the translator clamps per member); an
  // alias inherits its target's levels. Members with no advertised entry
  // (inactive/undetermined providers) fall back to the static resolvers.
  const comboByName = new Map(
    (Array.isArray(combos) ? combos : [])
      .filter((combo) => combo && typeof combo.name === "string")
      .map((combo) => [combo.name, combo]),
  );
  const modelsById = new Map(dedupedModels.map((model) => [model.id, model]));
  const staticEffortForModelString = (modelStr) => {
    const [prefix, ...rest] = modelStr.split("/");
    const base = rest.join("/") || prefix;
    return effortCapabilitiesForModelId(modelStr)
      || effortCapabilitiesFromThinkingLevels(prefix, base);
  };
  const resolveModelStringEffort = (modelStr, visiting = new Set(), comboDepth = 0) => {
    if (typeof modelStr !== "string" || !modelStr) return null;
    if (visiting.has(modelStr) || visiting.size > 32) return null;
    visiting.add(modelStr);
    let resolved = null;
    const combo = comboByName.get(modelStr);
    if (combo) {
      const nextDepth = comboDepth + 1;
      if (nextDepth <= MAX_COMBO_DEPTH) {
        const members = Array.isArray(combo.models) ? combo.models : [];
        resolved = unionEffortCapabilities(
          members.map((member) => resolveModelStringEffort(member, visiting, nextDepth)),
        );
      }
    } else if (modelAliases && Object.hasOwn(modelAliases, modelStr)) {
      resolved = resolveModelStringEffort(modelAliases[modelStr], visiting, comboDepth);
    } else {
      const entry = modelsById.get(modelStr);
      resolved = entry?.capabilities?.effort
        ? { effort: entry.capabilities.effort }
        : staticEffortForModelString(modelStr);
    }
    visiting.delete(modelStr);
    return resolved;
  };
  for (const entry of dedupedModels) {
    if (entry.capabilities?.effort) continue;
    let resolved = null;
    if (entry.owned_by === "combo") {
      const combo = comboByName.get(entry.id);
      if (!combo || (combo.kind || LLM_KIND) !== LLM_KIND) continue;
      resolved = resolveModelStringEffort(entry.id);
    } else if (entry.owned_by === "switchboard-alias") {
      resolved = resolveModelStringEffort(entry.id);
    }
    if (resolved?.effort) {
      entry.capabilities = { ...(entry.capabilities || {}), effort: resolved.effort };
    }
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
 * Build Claude Code gateway-discovery rows for the full-catalog profile.
 * Uses the saved selection directly so discovery stays within Claude Code's
 * 3-second timeout instead of re-fetching every provider catalog first.
 *
 * @param {string[]} selectedModelIds
 * @param {Record<string, string>} [pickerLabels]
 */
export function buildClaudeFullCatalogDiscoveryModels(selectedModelIds, pickerLabels = {}) {
  const customLabels = normalizeClaudeCatalogPickerLabels(pickerLabels, selectedModelIds);
  const displayNames = buildClaudeCatalogDisplayNameMap(selectedModelIds);
  return selectedModelIds.map((modelId) => ({
    id: encodeClaudeCatalogModelId(modelId),
    object: "model",
    created: 0,
    owned_by: "switchboard-catalog",
    display_name: customLabels[modelId]
      || formatClaudeCatalogDisplayName(modelId, displayNames),
    description: modelId,
  }));
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    if (isClaudeFullCatalogRequest(request?.headers)) {
      const selectedModelIds = readClaudeCatalogSelectionFromHeaders(request?.headers);
      const data = buildClaudeFullCatalogDiscoveryModels(
        selectedModelIds,
        readClaudeCatalogPickerLabelsFromHeaders(request?.headers),
      );
      return Response.json({ object: "list", data });
    }

    const models = await buildModelsList([LLM_KIND], {
      signal: request?.signal,
      skipCompatibleDiscovery: isModelCatalogDiscoveryRequest(request),
    });
    const data = models;
    return Response.json({ object: "list", data }, {
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: "Failed to fetch models", type: "server_error" } },
      { status: 500 }
    );
  }
}
