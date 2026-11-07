// @ts-check

// Browser-local endpoint presets shared by every CLI tool card. One store and
// one change event so a preset saved or deleted on one card shows up on every
// open card without a reload. Only { name, baseUrl } is persisted — legacy
// entries that still carry an apiKey are tolerated on read but never written
// back (T54).
const STORAGE_KEY = "switchboard.cliToolEndpointPresets";
const CHANGE_EVENT = "switchboard:endpoint-presets-changed";

function normalizePresets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((preset) => preset?.name && preset?.baseUrl)
    .map(({ name, baseUrl }) => ({ name, baseUrl }));
}

export function readPresets() {
  if (typeof window === "undefined") return [];
  try {
    return normalizePresets(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function writePresets(presets) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePresets(presets)));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Subscribe to preset changes from this tab (custom event) and other tabs (storage event). */
export function subscribePresets(handler) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event) => {
    if (event.key === STORAGE_KEY) handler();
  };
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}

/** Add or replace a preset by name; returns the updated, name-sorted list. */
export function upsertPreset(name, baseUrl) {
  const next = [
    ...readPresets().filter((preset) => preset.name !== name),
    { name, baseUrl },
  ].sort((a, b) => a.name.localeCompare(b.name));
  writePresets(next);
  return next;
}

/** Remove a preset by name; returns the updated list. */
export function deletePreset(name) {
  const next = readPresets().filter((preset) => preset.name !== name);
  writePresets(next);
  return next;
}
