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

/**
 * Merge, validate, and persist one combo's strategy, then reset its rotation.
 * @param {string} comboName
 * @param {Record<string, any>} strategy
 * @returns {Promise<Record<string, any>>}
 */
export async function updateComboStrategyChecked(comboName, strategy) {
  const settings = await getSettings();
  const merged = { ...(settings.comboStrategies || {}), [comboName]: strategy };
  const invalidAuto = findAutoComboMissingRouter({ [comboName]: strategy });
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

/**
 * Update a combo and maintain rotation, strategy, and routing history state.
 * Returns null when the combo does not exist, matching updateCombo.
 * @param {string} id
 * @param {Record<string, any>} data
 * @returns {Promise<any|null>}
 */
export async function updateComboWrite(id, data) {
  if (data.name) {
    validateComboName(data.name);
    await ensureComboNameAvailable(data.name, id);
  }

  const previous = await getComboById(id);
  const combo = await updateComboRecord(id, data);
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
