// @ts-check
/**
 * Shared Pi catalog core + automatic sync.
 *
 * The dashboard route (src/app/api/cli-tools/pi-settings/route.js) owns
 * connect/save/reset. This module owns the reusable pieces plus the
 * automatic sync: whenever custom models change (import / add / delete),
 * the managed entries in ~/.pi/agent/models.yml + models.json are rebuilt
 * with full metadata (reasoning + thinkingLevelMap) so Pi's picker stays
 * exact without any manual step.
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { replaceCliFiles } from "@/lib/cli/fileIo.js";
import {
  buildPiModelEntries,
  normalizeModelIds,
} from "@/lib/cli/modelCatalog.js";
import { getCombos, getCustomModels } from "@/lib/db/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import {
  ensureCompatibleReasoning,
  lookupCompatibleReasoningSupport,
} from "@/sse/services/compatibleReasoning.js";

export const PROVIDER_ID = "switchboard";
const BACKUP_VERSION = 1;

export const getAgentDir = () => path.join(os.homedir(), ".pi", "agent");
export const getModelsPath = () => path.join(getAgentDir(), "models.json");
export const getSettingsPath = () => path.join(getAgentDir(), "settings.json");
export const getBackupPath = () => path.join(getAgentDir(), "switchboard-backup.json");
// omp (Pi >= v18) reads models.yml and ignores models.json; plain pi still
// reads models.json. Both are written so every Pi variant sees the provider.
export const getModelsYmlPath = () => path.join(getAgentDir(), "models.yml");

export const normalizeBaseUrl = (baseUrl) => {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : `${u}/v1`;
};

export const isLocalBase = (url) => {
  try {
    const hostname = new URL(String(url || "")).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "0.0.0.0"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
};

const readJsonFile = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`${filePath} must contain a JSON object`);
    }
    return parsed;
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
};

const readYamlFile = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = raw.trim() === "" ? {} : parseYaml(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`${filePath} must contain a YAML object`);
    }
    return parsed;
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
};

export const readModels = () => readJsonFile(getModelsPath(), { providers: {} });
export const readSettings = () => readJsonFile(getSettingsPath(), {});
export const readBackup = () => readJsonFile(getBackupPath(), null);
export const readModelsYml = () => readYamlFile(getModelsYmlPath(), { providers: {} });

export const canonicalModelIds = (models) => models.map((model) => `${PROVIDER_ID}/${model}`);

/** Keep other providers visible. A switchboard-only whitelist is lifted. */
export const mergeEnabledModels = (existing, switchboardIds) => {
  if (!Array.isArray(existing) || existing.length === 0) return undefined;
  const others = existing.filter((id) => typeof id !== "string" || !id.startsWith(`${PROVIDER_ID}/`));
  if (others.length === 0) return undefined;
  return [...others, ...switchboardIds];
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

export const sameJson = (left, right) => (
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
);

const isSnapshot = (value) => value && typeof value === "object" && typeof value.exists === "boolean";

export const validateBackup = (backup) => {
  if (backup == null) return null;
  if (backup.version === BACKUP_VERSION && backup.state === "restored") return backup;
  const settingKeys = ["defaultProvider", "defaultModel", "enabledModels"];
  if (backup.version !== BACKUP_VERSION
    || !isSnapshot(backup.provider)
    || !settingKeys.every((key) => isSnapshot(backup.settings?.[key]))
    || !backup.managedProvider
    || !backup.managedSettings) {
    throw new Error("Unsupported or invalid Pi Switchboard backup file");
  }
  return backup;
};

export const writePiState = async (modelsYml, models, settings, backup) => {
  await fs.mkdir(getAgentDir(), { recursive: true });
  await replaceCliFiles([
    {
      filePath: getBackupPath(),
      content: backup ? JSON.stringify(backup, null, 2) : null,
      secret: true,
    },
    // Writing models.yml also bumps its mtime, which makes omp treat its
    // discovery cache as older than the config and refetch /v1/models.
    { filePath: getModelsYmlPath(), content: stringifyYaml(modelsYml), secret: true },
    { filePath: getModelsPath(), content: JSON.stringify(models, null, 2), secret: true },
    { filePath: getSettingsPath(), content: JSON.stringify(settings, null, 2), secret: true },
  ]);
};

// Serialize every mutation of the Pi files (dashboard save / reset / auto
// sync) in this process so two writers cannot publish a mixed configuration.
let mutationTail = Promise.resolve();

export const withPiMutationLock = (operation) => {
  const next = mutationTail.then(operation, operation);
  mutationTail = next.catch(() => {});
  return next;
};

/**
 * Capability resolver for Pi model entries: registry capability patterns +
 * thinking levels, compatible-node discovery (import-time catalog capture +
 * static host defaults), and combo member union (a combo can reason when any
 * member can — the gateway strips thinking per member when routing).
 */
export async function buildPiCapsResolver() {
  await ensureCompatibleReasoning().catch(() => {});
  const combos = typeof getCombos === "function"
    ? await Promise.resolve(getCombos()).catch(() => [])
    : [];
  const comboByName = new Map(combos.map((c) => [c.name, c]));
  const resolver = (fullId, visited = new Set()) => {
    try {
      const id = String(fullId || "");
      const slash = id.indexOf("/");
      if (slash <= 0) {
        if (visited.has(id)) return null; // nested-combo cycle guard
        visited.add(id);
        const combo = comboByName.get(id);
        if (!combo || !Array.isArray(combo.models) || combo.models.length === 0) return null;
        // Union across members: the combo routes to any of them, so Pi's
        // picker must expose every level at least one member accepts
        // (order-stable), and `reasoning` is true when ANY member reasons —
        // a non-reasoning first member must not mask the rest.
        let first = null;
        let reasoning = false;
        let levels = null;
        for (const member of combo.models) {
          const caps = resolver(String(member), visited);
          if (!caps) continue;
          if (!first) first = caps;
          if (caps.reasoning) reasoning = true;
          if (caps.reasoning && Array.isArray(caps.levels) && caps.levels.length) {
            levels = levels ? unionLevels(levels, caps.levels) : [...caps.levels];
          }
        }
        if (!first) return null;
        return { ...first, reasoning, ...(levels ? { levels } : {}) };
      }
      const prefix = id.slice(0, slash);
      const base = id.slice(slash + 1);
      const caps = getCapabilitiesForModel(prefix, base);
      const compat = lookupCompatibleReasoningSupport(prefix, base);
      if (compat) {
        // Compatible-node descriptor is authoritative for reasoning, but it
        // exposes no per-level set — never import registry vocabulary for it
        // (e.g. a compatible "glm-*" would otherwise map high→"thinking",
        // a value a flat reasoning_effort gateway rejects). No map → Pi's
        // default picker, and the gateway clamps per member when routing.
        return { reasoning: compat.supported === true, contextWindow: caps.contextWindow || null, levels: null };
      }
      const levels = getThinkingLevels(prefix, base);
      return { reasoning: caps.reasoning === true, contextWindow: caps.contextWindow || null, levels };
    } catch {
      return null;
    }
  };
  return resolver;
}

// Canonical order so unioned combo levels stay deterministic.
const LEVEL_ORDER = ["none", "thinking", "minimal", "low", "medium", "high", "xhigh", "max"];

function unionLevels(a, b) {
  const set = new Set([...a, ...b]);
  return LEVEL_ORDER.filter((l) => set.has(l));
}

/**
 * @param {string[]} prevIds
 * @param {Set<string>} currentIds
 * @param {string[]} injectedIds ids auto-injected by earlier syncs
 * @returns {{ merged: string[], injected: string[] }} merged ids + ids sync owns after this run
 */
export function planPiSync(prevIds, currentIds, injectedIds = []) {
  const injectedPrev = new Set(injectedIds);
  const appended = [...currentIds].filter((id) => !prevIds.includes(id));
  const injected = [...new Set([
    ...appended,
    ...injectedIds.filter((id) => currentIds.has(id)),
  ])];
  const merged = [...new Set([
    ...prevIds.filter((id) => !injectedPrev.has(id)),
    ...currentIds,
  ])];
  return { merged, injected };
}

/**
 * Automatic catalog sync — called (debounced) after custom models change.
 * No-op unless Switchboard actively manages Pi (backup state "active" and
 * a provider entry with entries present). Throws on DB read failure so a
 * broken read never prunes live entries. Never throws otherwise.
 */
export async function syncPiCatalog() {
  const backup = validateBackup(await readBackup());
  if (!backup || backup.state !== "active") return;
  const [ymlData, data, piSettings, custom] = await Promise.all([
    readModelsYml(),
    readModels(),
    readSettings(),
    getCustomModels(), // deliberate: a failed read must abort, not prune
  ]);
  const prevEntries = Array.isArray(ymlData?.providers?.[PROVIDER_ID]?.models)
    ? ymlData.providers[PROVIDER_ID].models
    : (Array.isArray(data?.providers?.[PROVIDER_ID]?.models)
      ? data.providers[PROVIDER_ID].models
      : []);
  const base = ymlData?.providers?.[PROVIDER_ID] || data?.providers?.[PROVIDER_ID];
  if (!base || !Array.isArray(base.models)) return;

  const currentIds = new Set(
    custom
      .filter((m) => m?.providerAlias && m?.id && (m.type || "llm") === "llm")
      .map((m) => `${m.providerAlias}/${m.id}`),
  );
  const prevIds = prevEntries.map((e) => e?.id).filter(Boolean);
  const { merged, injected } = planPiSync(prevIds, currentIds, backup.syncSourceIds || []);

  // Always rebuild entries: unchanged ids must still pick up repaired
  // metadata (reasoning flags, thinkingLevelMap) from the current registry.
  const resolver = await buildPiCapsResolver();
  const labels = Object.fromEntries(prevEntries.filter((e) => e?.id && e?.name).map((e) => [e.id, e.name]));
  const entries = buildPiModelEntries(merged, prevEntries, labels, resolver);
  if (sameJson(entries, prevEntries)
    && sameJson(injected, backup.syncSourceIds || [])) return;

  // Provider fields (baseUrl/apiKey/compat) come from the file as-is — user
  // edits survive — but the managed snapshots in the backup keep the fields
  // Apply wrote, so Disconnect ownership checks never adopt user edits.
  const managedProvider = { ...base, models: entries };
  const managedYmlProvider = {
    ...managedProvider,
    discovery: base.discovery || { type: "openai-models-list" },
  };
  backup.syncSourceIds = injected;
  backup.managedProvider = { ...(backup.managedProvider || managedYmlProvider), models: entries };
  backup.managedLegacyProvider = { ...(backup.managedLegacyProvider || managedProvider), models: entries };

  // Settings: touch only what dangles, and only while we still own it
  // (current value equals what Apply/sync last wrote — user edits win).
  const owned = backup.managedSettings || null;
  if (piSettings.defaultProvider === PROVIDER_ID
    && piSettings.defaultModel
    && owned
    && piSettings.defaultModel === owned.defaultModel
    && !merged.includes(piSettings.defaultModel)
    && merged.length > 0) {
    piSettings.defaultModel = merged[0];
    backup.managedSettings = {
      ...(owned || { defaultProvider: PROVIDER_ID }),
      defaultModel: piSettings.defaultModel,
    };
  }
  if (Array.isArray(piSettings.enabledModels)
    && sameJson(piSettings.enabledModels, owned?.enabledModels)) {
    const mergedEnabled = mergeEnabledModels(piSettings.enabledModels, canonicalModelIds(merged));
    if (mergedEnabled) piSettings.enabledModels = mergedEnabled;
    else delete piSettings.enabledModels;
    backup.managedSettings = {
      ...(backup.managedSettings || { defaultProvider: PROVIDER_ID }),
      defaultModel: piSettings.defaultModel,
      enabledModels: piSettings.enabledModels,
    };
  }

  if (!ymlData.providers || typeof ymlData.providers !== "object") ymlData.providers = {};
  if (!data.providers || typeof data.providers !== "object") data.providers = {};
  ymlData.providers[PROVIDER_ID] = managedYmlProvider;
  data.providers[PROVIDER_ID] = managedProvider;

  await writePiState(ymlData, data, piSettings, backup);
}

let syncTimer = null;

/** Debounced fire-and-forget sync — call after any custom-model mutation. */
export function schedulePiCatalogSync(delayMs = 3000) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    withPiMutationLock(syncPiCatalog).catch((error) => {
      // Failed syncs keep the last good catalog; never crash the timer.
      console.log("Pi catalog sync failed:", error?.message || error);
    });
  }, delayMs);
}
