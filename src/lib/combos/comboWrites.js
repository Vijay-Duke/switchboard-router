import {
  createCombo as createComboRecord,
  deleteCombo as deleteComboRecord,
  deleteRoutingDataForCombo,
  getComboById,
  getComboByName,
  getSettings,
  rekeyRoutingDataForCombo,
  updateCombo as updateComboRecord,
  updateSettings,
} from "@/lib/db/index.js";
import { resetComboRotation } from "open-sse/services/combo.js";

/** Combo names are part of the public model identifier. */
export const VALID_COMBO_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

export const COMBO_NAME_REQUIRED_ERROR = "Name is required";
export const INVALID_COMBO_NAME_ERROR = "Name can only contain letters, numbers, -, _ and .";
export const DUPLICATE_COMBO_NAME_ERROR = "Combo name already exists";

/** @param {string} name @returns {string} */
export const AUTO_ROUTER_REQUIRED_ERROR = (name) =>
  `Auto combo "${name}" requires a router model — select one in the combo's Auto settings (a cheap, fast model such as Haiku works well).`;

/** Error callers can turn into the established 400 JSON response. */
export class ComboWriteError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status = 400) {
    super(message);
    this.name = "ComboWriteError";
    this.status = status;
  }
}

/**
 * Validate a supplied combo name using the legacy public API contract.
 * @param {unknown} name
 * @returns {void}
 */
export function validateComboName(name) {
  if (!VALID_COMBO_NAME_REGEX.test(name)) {
    throw new ComboWriteError(INVALID_COMBO_NAME_ERROR);
  }
}

/**
 * Reject a combo name assigned to a different combo.
 * @param {unknown} name
 * @param {string|undefined} currentId
 * @returns {Promise<void>}
 */
export async function ensureComboNameAvailable(name, currentId) {
  const existing = await getComboByName(name);
  if (existing && existing.id !== currentId) {
    throw new ComboWriteError(DUPLICATE_COMBO_NAME_ERROR);
  }
}

/**
 * Return the first Auto combo strategy without a non-blank router model.
 * @param {Record<string, any>|undefined|null} comboStrategies
 * @returns {string|null}
 */
export function findAutoComboMissingRouter(comboStrategies) {
  if (!comboStrategies || typeof comboStrategies !== "object") return null;
  for (const [name, strat] of Object.entries(comboStrategies)) {
    if (!strat || strat.fallbackStrategy !== "auto") continue;
    const router = strat.routerModel;
    if (!router || typeof router !== "string" || !router.trim()) return name;
  }
  return null;
}

// Known strategy schema. Anything else is dropped — persisted strategies are
// read back by the router (e.g. `strategy.filterWorker` is INVOKED as a
// function in handleAutoChat), so arbitrary client keys must never reach settings.
const STRATEGY_ALLOWED_KEYS = new Set([
  "fallbackStrategy", "routerModel", "objective", "judgeModel",
  "explorationRate", "explorationRateCap",
  "learningEnabled", "learningWindowDays", "freezeLearning",
  "activeLearningVersionId", "autoLearnIntervalHours",
  "capacityAutoSwitch", "emitAutoRouterHeaders",
  "fusionTuning", "autoTuning",
]);
const AUTO_TUNING_ALLOWED_KEYS = new Set([
  "heuristicFirst", "maxFewShots", "minEventsBeforeLearn",
]);
const FUSION_TUNING_ALLOWED_KEYS = new Set([
  "cachedRoutes", "policyFastPath", "routerTimeoutMs",
]);

/**
 * @param {Record<string, any>} value
 * @param {Set<string>} allowed
 * @returns {Record<string, any>}
 */
function pickAllowedKeys(value, allowed) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (allowed.has(key)) out[key] = v;
  }
  return out;
}

/**
 * Reduce client strategy input to the known schema (unknown keys dropped).
 * Rejects non-object input; nested tuning objects get their own allowlists.
 * @param {unknown} strategy
 * @returns {Record<string, any>}
 */
export function sanitizeStrategyInput(strategy) {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
    throw new ComboWriteError("Strategy must be a JSON object", 400);
  }
  const safe = pickAllowedKeys(/** @type {Record<string, any>} */ (strategy), STRATEGY_ALLOWED_KEYS);
  for (const [key, allowed] of /** @type {[string, Set<string>][]} */ ([
    ["autoTuning", AUTO_TUNING_ALLOWED_KEYS],
    ["fusionTuning", FUSION_TUNING_ALLOWED_KEYS],
  ])) {
    if (!(key in safe)) continue;
    const nested = safe[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      delete safe[key];
      continue;
    }
    safe[key] = pickAllowedKeys(nested, allowed);
  }
  return safe;
}

/**
 * Merge, validate, and persist one combo's strategy, then reset its rotation.
 * Input is allowlisted to the known strategy schema before persisting.
 * @param {string} comboName
 * @param {Record<string, any>} strategy
 * @returns {Promise<Record<string, any>>}
 */
export async function updateComboStrategyChecked(comboName, strategy) {
  const safeStrategy = sanitizeStrategyInput(strategy);
  const settings = await getSettings();
  const merged = { ...(settings.comboStrategies || {}), [comboName]: safeStrategy };
  const invalidAuto = findAutoComboMissingRouter({ [comboName]: safeStrategy });
  if (invalidAuto) {
    throw new ComboWriteError(AUTO_ROUTER_REQUIRED_ERROR(invalidAuto), 400);
  }

  await updateSettings({ comboStrategies: merged });
  resetComboRotation(comboName);
  return merged[comboName];
}

/**
 * Move or drop per-combo strategy after a rename or deletion.
 * Existing target data wins when both names already have a strategy.
 * @param {string|undefined|null} oldName
 * @param {string|undefined|null} newName
 * @returns {Promise<void>}
 */
export async function rekeyComboStrategy(oldName, newName) {
  if (!oldName || oldName === newName) return;

  const settings = await getSettings();
  const strategies = { ...(settings.comboStrategies || {}) };
  if (!(oldName in strategies)) return;

  if (newName && !(newName in strategies)) {
    strategies[newName] = strategies[oldName];
  }
  delete strategies[oldName];
  await updateSettings({ comboStrategies: strategies });
}

/**
 * Create a combo after applying the legacy name and uniqueness checks.
 * @param {{name: unknown, models?: unknown, kind?: unknown}} data
 * @returns {Promise<any>}
 */
export async function createComboWrite(data) {
  const { name, models, kind } = data;
  if (!name) throw new ComboWriteError(COMBO_NAME_REQUIRED_ERROR);

  validateComboName(name);
  await ensureComboNameAvailable(name, undefined);
  return createComboRecord({ name, models: models || [], kind: kind || null });
}

// Persisted combo fields writable by clients. Everything else is dropped so a
// request body can never mass-assign onto the merged combo record.
const COMBO_WRITABLE_FIELDS = ["name", "models", "kind"];

/**
 * Update a combo and maintain rotation, strategy, and routing history state.
 * Returns null when the combo does not exist, matching updateCombo.
 * Only `name`, `models`, and `kind` are accepted; unknown keys are dropped.
 * @param {string} id
 * @param {Record<string, any>} data
 * @returns {Promise<any|null>}
 */
export async function updateComboWrite(id, data) {
  /** @type {Record<string, any>} */
  const safeData = {};
  for (const field of COMBO_WRITABLE_FIELDS) {
    if (data && Object.prototype.hasOwnProperty.call(data, field)) {
      safeData[field] = data[field];
    }
  }

  if (safeData.name) {
    validateComboName(safeData.name);
    await ensureComboNameAvailable(safeData.name, id);
  }

  const previous = await getComboById(id);
  const combo = await updateComboRecord(id, safeData);
  if (!combo) return null;

  if (previous?.name) resetComboRotation(previous.name);
  if (combo.name && combo.name !== previous?.name) {
    resetComboRotation(combo.name);
    await rekeyComboStrategy(previous.name, combo.name);
    try {
      await rekeyRoutingDataForCombo(previous.name, combo.name);
    } catch (error) {
      console.warn("rekey routing data failed:", error?.message || error);
    }
  }

  return combo;
}

/**
 * Delete a combo and remove state keyed by its name.
 * Returns false when the combo does not exist, matching deleteCombo.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteComboWrite(id) {
  const previous = await getComboById(id);
  const success = await deleteComboRecord(id);
  if (!success) return false;

  if (previous?.name) {
    resetComboRotation(previous.name);
    await rekeyComboStrategy(previous.name, null);
    try {
      await deleteRoutingDataForCombo(previous.name);
    } catch (error) {
      console.warn("delete routing data failed:", error?.message || error);
    }
  }

  return true;
}
