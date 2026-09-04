// Explicit opt-in for deleting a provider's strategy entry. An `update()`
// that returns `undefined` is a no-op (keeps the previous entry, skips the
// write) so a buggy updater can never silently wipe a provider's strategy.
export const DELETE_PROVIDER_STRATEGY = Symbol("delete-provider-strategy");

// Serializes concurrent saves from this client (e.g. strategy + scheduler
// savers firing together) so the second GET sees the first PATCH instead of
// last-writer-wins clobbering it. Cross-tab races still need a server-side
// per-provider merge.
let patchQueue = Promise.resolve();

export async function patchProviderStrategy(providerId, update, fetchImpl = fetch) {
  const run = patchQueue.then(() => doPatchProviderStrategy(providerId, update, fetchImpl));
  // Keep the queue alive across failures; each caller still sees its own error.
  patchQueue = run.catch(() => {});
  return run;
}

async function doPatchProviderStrategy(providerId, update, fetchImpl) {
  const settingsResponse = await fetchImpl("/api/settings", { cache: "no-store" });
  if (!settingsResponse.ok) {
    throw new Error(`Failed to load settings (${settingsResponse.status})`);
  }

  const settings = await settingsResponse.json();
  const current = settings.providerStrategies || {};
  const previous = current[providerId] || {};
  const next = update(previous);
  if (next === undefined) {
    console.warn(
      `[patchProviderStrategy] updater for "${providerId}" returned undefined; keeping previous entry`,
    );
    return previous;
  }
  const providerStrategies = { ...current };
  if (next === DELETE_PROVIDER_STRATEGY) delete providerStrategies[providerId];
  else if (next && Object.keys(next).length > 0) providerStrategies[providerId] = next;
  else delete providerStrategies[providerId];

  const patchResponse = await fetchImpl("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerStrategies }),
  });
  if (!patchResponse.ok) {
    throw new Error(`Failed to save settings (${patchResponse.status})`);
  }

  return next === DELETE_PROVIDER_STRATEGY ? undefined : next;
}
