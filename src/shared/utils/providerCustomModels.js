import { canonicalModelId } from "@/lib/model-probe/canonicalId.js";
import { asServiceKind } from "@/shared/utils/importProviderModels";
import { ALIAS_TO_ID } from "@/shared/constants/providers";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";

function modelType(model) {
  return asServiceKind(model?.kind || model?.type || "llm");
}

export function buildCanonicalDisabledModelSet(modelIds, providerAlias = "") {
  return new Set(
    (Array.isArray(modelIds) ? modelIds : [])
      .map((modelId) => canonicalModelId(modelId, providerAlias))
      .filter(Boolean),
  );
}

export function isCanonicalModelDisabled(disabledIds, modelId, providerAlias = "") {
  return disabledIds.has(canonicalModelId(modelId, providerAlias));
}

/**
 * Filter provider-grouped picker models by a free-text query.
 * When the provider NAME matches, every model in that group is kept;
 * otherwise a model matches by its display name, id, or full
 * `provider/model` value (so an `alias/` prefix query works).
 *
 * @param {Record<string, { name?: string, models?: Array<{ name?: string, id?: string, value?: string }> }>} groupedModels
 * @param {string} searchQuery
 * @returns {Record<string, any>} filtered groups (groups with zero models omitted)
 */
export function filterModelGroupsByQuery(groupedModels, searchQuery) {
  const query = String(searchQuery || "").trim().toLowerCase();
  if (!query) return groupedModels || {};
  const filtered = {};
  for (const [providerId, group] of Object.entries(groupedModels || {})) {
    const models = Array.isArray(group?.models) ? group.models : [];
    if (group?.name && String(group.name).toLowerCase().includes(query)) {
      filtered[providerId] = { ...group, models: [...models] };
      continue;
    }
    const kept = models.filter((m) =>
      String(m?.name || "").toLowerCase().includes(query) ||
      String(m?.id || "").toLowerCase().includes(query) ||
      String(m?.value || "").toLowerCase().includes(query),
    );
    if (kept.length === 0) continue;
    filtered[providerId] = { ...group, models: kept };
  }
  return filtered;
}

export function getProviderCustomModelRows({
  customModels = [],
  modelAliases = {},
  providerAlias,
  builtInModels = [],
  type = "llm",
  includeLegacyAliases = true,
  // Older imports may have stored models under a previous storage key (e.g.
  // the registry id before a uiAlias rename — "opencode-go" vs "ocg"). Rows
  // still render under the CURRENT alias.
  legacyStorageAliases = [],
}) {
  const builtInIds = new Set(builtInModels.map((model) => model.id));
  const seenFullModels = new Set();
  const rows = [];
  const storageKeys = new Set([
    providerAlias,
    ...legacyStorageAliases.filter((a) => typeof a === "string" && a && a !== providerAlias),
  ]);
  // Custom models are stored under the provider's UI alias, but imports written
  // before a uiAlias rename used the registry id/alias ("opencode-go" vs
  // "ocg", "xiaomi-mimo" vs "mimo"). Derive those keys here so every caller
  // resolves historical rows without threading the provider id through.
  const providerId = providerAlias ? ALIAS_TO_ID[providerAlias] : null;
  if (providerId) {
    storageKeys.add(providerId);
    if (PROVIDER_ID_TO_ALIAS[providerId]) storageKeys.add(PROVIDER_ID_TO_ALIAS[providerId]);
  }

  // A stale legacy-alias copy must never shadow the current-alias row for the
  // same model id (stale name/metadata). Iteration order is otherwise kept.
  const currentAliasIds = new Set(
    customModels.filter((m) => m?.providerAlias === providerAlias).map((m) => m?.id),
  );

  for (const model of customModels) {
    if (!model?.id || !storageKeys.has(model.providerAlias)) continue;
    if (model.providerAlias !== providerAlias && currentAliasIds.has(model.id)) continue;
    const rowType = modelType(model);
    if (type && rowType !== type) continue;
    if (builtInIds.has(model.id)) continue;

    const fullModel = `${providerAlias}/${model.id}`;
    if (seenFullModels.has(fullModel)) continue;
    seenFullModels.add(fullModel);
    rows.push({
      id: model.id,
      name: model.name || model.id,
      fullModel,
      source: "custom",
      type: rowType,
    });
  }

  if (!includeLegacyAliases) return rows;

  const prefix = `${providerAlias}/`;
  for (const [alias, fullModel] of Object.entries(modelAliases || {})) {
    if (typeof fullModel !== "string" || !fullModel.startsWith(prefix)) continue;
    const id = fullModel.slice(prefix.length);
    if (!id || builtInIds.has(id) || seenFullModels.has(fullModel)) continue;

    seenFullModels.add(fullModel);
    rows.push({
      id,
      alias,
      fullModel,
      source: "legacyAlias",
      type: type || "llm",
    });
  }

  return rows;
}

/**
 * Build model-picker rows from the runtime catalog, enriching live entries with
 * static/custom metadata. Static rows are a fallback only when live discovery
 * has not completed successfully.
 */
export function getSelectableProviderModelRows({
  providerAlias,
  builtInModels = [],
  customModels = [],
  modelAliases = {},
  liveModels = [],
  liveCatalogLoaded = false,
  legacyStorageAliases = [],
}) {
  const fallbackRows = [];
  const metadataByValue = new Map();
  const addFallback = (row) => {
    if (!row?.id || !row?.value || metadataByValue.has(row.value)) return;
    metadataByValue.set(row.value, row);
    fallbackRows.push(row);
  };

  for (const model of builtInModels) {
    if (!model?.id) continue;
    addFallback({
      ...model,
      name: model.name || model.id,
      value: `${providerAlias}/${model.id}`,
    });
  }

  const customRows = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias,
    builtInModels,
    type: "llm",
    legacyStorageAliases,
  });
  for (const model of customRows) {
    addFallback({
      id: model.id,
      name: model.name || model.alias || model.id,
      value: model.fullModel,
      type: model.type,
      isCustom: true,
    });
  }

  if (!liveCatalogLoaded) return fallbackRows;

  const rows = [];
  const seen = new Set();
  const prefix = `${providerAlias}/`;
  for (const model of liveModels) {
    if (typeof model?.id !== "string" || !model.id.startsWith(prefix)) continue;
    const id = model.id.slice(prefix.length);
    if (!id || seen.has(model.id)) continue;
    seen.add(model.id);
    const metadata = metadataByValue.get(model.id);
    rows.push({
      ...(metadata || {}),
      id,
      name: model.name || metadata?.name || id,
      value: model.id,
      kind: model.kind || metadata?.kind,
      capabilities: model.capabilities || metadata?.capabilities,
      // Live-discovered models are not custom — only rows the user added
      // via the custom-models list carry isCustom.
      isCustom: metadata?.isCustom === true,
    });
  }

  return rows;
}

/**
 * Build picker rows for UUID-backed compatible providers. Their display prefix
 * differs from the provider ID used to store aliases/custom models, so the
 * normal provider helper cannot join the two catalogs directly.
 */
export function getCompatibleProviderModelRows({
  providerId,
  providerAlias,
  customModels = [],
  modelAliases = {},
  liveModels = [],
  liveCatalogLoaded = false,
}) {
  const metadataByValue = new Map();
  const fallbackRows = [];
  const addFallback = (row) => {
    if (!row?.id || !row?.value || metadataByValue.has(row.value)) return;
    metadataByValue.set(row.value, row);
    fallbackRows.push(row);
  };

  for (const [aliasName, fullModel] of Object.entries(modelAliases || {})) {
    const storagePrefix = `${providerId}/`;
    if (typeof fullModel !== "string" || !fullModel.startsWith(storagePrefix)) continue;
    const id = fullModel.slice(storagePrefix.length);
    addFallback({ id, name: aliasName, value: `${providerAlias}/${id}` });
  }
  for (const model of customModels) {
    if (!model?.id || model.providerAlias !== providerId) continue;
    addFallback({
      id: model.id,
      name: model.name || model.id,
      value: `${providerAlias}/${model.id}`,
      isCustom: true,
    });
  }

  if (!liveCatalogLoaded) return fallbackRows;

  const prefix = `${providerAlias}/`;
  const rows = [];
  const seen = new Set();
  for (const model of liveModels) {
    if (typeof model?.id !== "string" || !model.id.startsWith(prefix) || seen.has(model.id)) continue;
    const id = model.id.slice(prefix.length);
    if (!id) continue;
    seen.add(model.id);
    const metadata = metadataByValue.get(model.id);
    rows.push({
      ...(metadata || {}),
      id,
      name: model.name || metadata?.name || id,
      value: model.id,
      kind: model.kind || metadata?.kind,
      capabilities: model.capabilities || metadata?.capabilities,
      // Live-discovered models are not custom — only rows the user added
      // via the custom-models list carry isCustom.
      isCustom: metadata?.isCustom === true,
    });
  }
  return rows.length > 0 ? rows : fallbackRows;
}
