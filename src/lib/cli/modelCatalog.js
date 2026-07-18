// @ts-check

import { parseDocument } from "yaml";

const AIDER_BACKUP_MARKER = "# switchboard-managed-aider:";
const HERMES_BACKUP_MARKER = "# switchboard-managed-hermes:";

/** @param {unknown} value */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {unknown} value */
export function isOptionalString(value) {
  return value == null || typeof value === "string";
}

/** @param {unknown} value */
export function normalizeModelIds(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * @param {unknown} value
 * @param {string[]} models
 */
export function resolveDefaultModel(value, models) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate && models.includes(candidate) ? candidate : models[0] || "";
}

/** @param {string} id */
export function modelDisplayName(id) {
  const parts = id.split("/");
  return parts[parts.length - 1] || id;
}

/**
 * @param {unknown} modelIds
 * @param {Array<Record<string, any>>} [previous]
 * @param {Record<string, string>} [pickerLabels]
 */
export function buildPiModelEntries(modelIds, previous = [], pickerLabels = {}) {
  const byId = new Map(previous.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  return normalizeModelIds(modelIds).map((id) => ({
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    ...byId.get(id),
    id,
    name: String(pickerLabels[id] || "").trim().slice(0, 48)
      || byId.get(id)?.name
      || modelDisplayName(id),
  }));
}

/**
 * @param {{baseUrl: string, models: unknown, defaultModel?: string}} options
 */
export function buildJcodeProvider({ baseUrl, models: rawModels, defaultModel }) {
  const models = normalizeModelIds(rawModels);
  const activeModel = resolveDefaultModel(defaultModel, models);
  return {
    type: "openai-compatible",
    base_url: baseUrl,
    auth: "bearer",
    api_key_env: "JCODE_SWITCHBOARD_API_KEY",
    env_file: "provider-switchboard.env",
    default_model: activeModel,
    model_catalog: true,
    requires_api_key: true,
    models: models.map((id) => ({ id })),
  };
}

/** @param {unknown} value */
function encodeBackup(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** @param {string} text @param {string} marker */
function readBackup(text, marker) {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(marker));
  if (!line) return null;
  try {
    return JSON.parse(Buffer.from(line.slice(marker.length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** @param {string} text @param {string} marker */
function stripBackupMarker(text, marker) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(marker))
    .join("\n");
}

/** @param {any} value */
function yamlValue(value) {
  return value?.toJSON ? value.toJSON() : value;
}

/** @param {string[]} models */
function buildAiderAliases(models) {
  const counts = new Map();
  return models.map((id) => {
    const slug = id.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
    const count = (counts.get(slug) || 0) + 1;
    counts.set(slug, count);
    const suffix = count === 1 ? "" : `-${count}`;
    return `switchboard-${slug}${suffix}:openai/${id}`;
  });
}

/**
 * @param {string} yaml
 * @param {{baseUrl: string, apiKey: string, models: unknown, defaultModel?: string}} options
 */
export function buildAiderYaml(yaml, { baseUrl, apiKey, models: rawModels, defaultModel }) {
  const restored = readBackup(yaml, AIDER_BACKUP_MARKER) ? removeAiderYaml(yaml) : yaml;
  const doc = parseDocument(restored || "");
  if (doc.errors.length) throw new Error(`Invalid Aider YAML: ${doc.errors[0].message}`);
  const models = normalizeModelIds(rawModels);
  const activeModel = resolveDefaultModel(defaultModel, models);
  const keys = ["openai-api-base", "openai-api-key", "model", "alias"];
  const backup = Object.fromEntries(keys.map((key) => [key, {
    exists: doc.hasIn([key]),
    value: yamlValue(doc.getIn([key])),
  }]));

  doc.setIn(["openai-api-base"], baseUrl);
  doc.setIn(["openai-api-key"], apiKey);
  doc.setIn(["model"], `openai/${activeModel}`);
  doc.setIn(["alias"], buildAiderAliases(models));
  return `${doc.toString().trimEnd()}\n${AIDER_BACKUP_MARKER}${encodeBackup(backup)}\n`;
}

/** @param {string} yaml */
export function removeAiderYaml(yaml) {
  const backup = readBackup(yaml, AIDER_BACKUP_MARKER);
  if (!backup) return yaml;
  const doc = parseDocument(stripBackupMarker(yaml, AIDER_BACKUP_MARKER));
  if (doc.errors.length) throw new Error(`Invalid Aider YAML: ${doc.errors[0].message}`);
  for (const key of ["openai-api-base", "openai-api-key", "model", "alias"]) {
    if (backup[key]?.exists) doc.setIn([key], backup[key].value);
    else doc.deleteIn([key]);
  }
  return doc.toString();
}

/**
 * @param {string} yaml
 * @param {{baseUrl: string, models: unknown, defaultModel?: string}} options
 */
export function buildHermesYaml(yaml, { baseUrl, models: rawModels, defaultModel }) {
  const restored = readBackup(yaml, HERMES_BACKUP_MARKER) ? removeHermesYaml(yaml) : yaml;
  const doc = parseDocument(restored || "");
  if (doc.errors.length) throw new Error(`Invalid Hermes YAML: ${doc.errors[0].message}`);
  const models = normalizeModelIds(rawModels);
  const activeModel = resolveDefaultModel(defaultModel, models);
  const providers = yamlValue(doc.getIn(["custom_providers"]));
  const providerList = Array.isArray(providers) ? providers : [];
  const previousProvider = providerList.find((provider) => provider?.name === "switchboard");
  const previousModel = yamlValue(doc.getIn(["model"]));
  const backup = { previousProvider: previousProvider ?? null, previousModel: previousModel ?? null };
  const remaining = providerList.filter((provider) => provider?.name !== "switchboard");
  const modelMap = Object.fromEntries(models.map((id) => [id, {}]));
  remaining.push({
    name: "switchboard",
    base_url: baseUrl,
    key_env: "SWITCHBOARD_API_KEY",
    api_mode: "chat_completions",
    models: modelMap,
  });
  doc.setIn(["custom_providers"], remaining);
  doc.setIn(["model"], {
    ...(previousModel && typeof previousModel === "object" ? previousModel : {}),
    default: activeModel,
    provider: "custom:switchboard",
  });
  return `${doc.toString().trimEnd()}\n${HERMES_BACKUP_MARKER}${encodeBackup(backup)}\n`;
}

/** @param {string} yaml */
export function removeHermesYaml(yaml) {
  const backup = readBackup(yaml, HERMES_BACKUP_MARKER);
  const doc = parseDocument(stripBackupMarker(yaml, HERMES_BACKUP_MARKER));
  if (doc.errors.length) throw new Error(`Invalid Hermes YAML: ${doc.errors[0].message}`);
  const providers = yamlValue(doc.getIn(["custom_providers"]));
  if (Array.isArray(providers)) {
    const remaining = providers.filter((provider) => provider?.name !== "switchboard");
    if (backup?.previousProvider) remaining.push(backup.previousProvider);
    if (remaining.length) doc.setIn(["custom_providers"], remaining);
    else doc.deleteIn(["custom_providers"]);
  }
  const currentProvider = yamlValue(doc.getIn(["model", "provider"]));
  if (currentProvider === "custom:switchboard") {
    if (backup?.previousModel) doc.setIn(["model"], backup.previousModel);
    else doc.deleteIn(["model"]);
  }
  return doc.toString();
}

/**
 * @param {Record<string, any>} config
 * @param {{baseUrl: string, apiKey: string, models: unknown, defaultModel?: string}} options
 */
export function buildKiloConfig(config, { baseUrl, apiKey, models: rawModels, defaultModel }) {
  const models = normalizeModelIds(rawModels);
  const activeModel = resolveDefaultModel(defaultModel, models);
  return {
    ...config,
    model: `switchboard/${activeModel}`,
    provider: {
      ...(config.provider || {}),
      switchboard: {
        npm: "@ai-sdk/openai-compatible",
        name: "Switchboard",
        options: { apiKey, baseURL: baseUrl },
        models: Object.fromEntries(models.map((id) => [id, { name: modelDisplayName(id) }])),
      },
    },
  };
}

/**
 * @param {{providers?: Record<string, any>, models?: Record<string, any>}} current
 * @param {{baseUrl: string, apiKey: string, models: unknown, defaultModel?: string}} options
 */
export function buildClineSettings(current, { baseUrl, apiKey, models: rawModels, defaultModel }) {
  const models = normalizeModelIds(rawModels);
  const activeModel = resolveDefaultModel(defaultModel, models);
  const providersFile = current.providers || {};
  const modelsFile = current.models || {};
  return {
    providers: {
      ...providersFile,
      providers: {
        ...(providersFile.providers || {}),
        switchboard: {
          type: "openai-compatible",
          name: "Switchboard",
          baseUrl,
          apiKey,
          defaultModelId: activeModel,
        },
      },
    },
    models: {
      ...modelsFile,
      providers: {
        ...(modelsFile.providers || {}),
        switchboard: {
          provider: {
            name: "Switchboard",
            baseUrl,
            defaultModelId: activeModel,
          },
          models: Object.fromEntries(models.map((id) => [id, { id, name: modelDisplayName(id) }])),
        },
      },
    },
  };
}

/**
 * @param {Record<string, any>} settings
 * @param {{models: unknown, defaultModel?: string}} options
 */
export function buildGeminiSettings(settings, { models: rawModels, defaultModel }) {
  const models = normalizeModelIds(rawModels);
  const activeModel = resolveDefaultModel(defaultModel, models);
  const existingDefinitions = settings?.modelConfigs?.modelDefinitions && typeof settings.modelConfigs.modelDefinitions === "object"
    ? settings.modelConfigs.modelDefinitions
    : {};
  const preservedDefinitions = Object.fromEntries(
    Object.entries(existingDefinitions).filter(([, definition]) => definition?.family !== "switchboard")
  );
  return {
    ...settings,
    model: { ...(settings.model || {}), name: activeModel },
    experimental: { ...(settings.experimental || {}), dynamicModelConfiguration: true },
    modelConfigs: {
      ...(settings.modelConfigs || {}),
      modelDefinitions: {
        ...preservedDefinitions,
        ...Object.fromEntries(models.map((id) => [id, {
          displayName: `Switchboard · ${modelDisplayName(id)}`,
          family: "switchboard",
          tier: "custom",
          isPreview: false,
          isVisible: true,
          features: { thinking: true, multimodalToolUse: true },
        }])),
      },
    },
  };
}
