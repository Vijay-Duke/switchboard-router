// @ts-check

const MANAGED_ID_PREFIXES = ["custom:Switchboard", "custom:9Router"];

/** @param {{ id?: unknown } | null | undefined} entry */
export function isSwitchboardManagedModel(entry) {
  if (typeof entry?.id !== "string") return false;
  return MANAGED_ID_PREFIXES.some((prefix) => entry.id.startsWith(prefix));
}

/** @param {unknown} value */
export function normalizeManagedModelNames(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((model) => typeof model === "string")
      .map((model) => model.trim())
      .filter(Boolean)
  )];
}
