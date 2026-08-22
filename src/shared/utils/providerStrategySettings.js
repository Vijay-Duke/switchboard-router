export async function patchProviderStrategy(providerId, update, fetchImpl = fetch) {
  const settingsResponse = await fetchImpl("/api/settings", { cache: "no-store" });
  if (!settingsResponse.ok) {
    throw new Error(`Failed to load settings (${settingsResponse.status})`);
  }

  const settings = await settingsResponse.json();
  const current = settings.providerStrategies || {};
  const previous = current[providerId] || {};
  const next = update(previous);
  const providerStrategies = { ...current };
  if (next && Object.keys(next).length > 0) providerStrategies[providerId] = next;
  else delete providerStrategies[providerId];

  const patchResponse = await fetchImpl("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerStrategies }),
  });
  if (!patchResponse.ok) {
    throw new Error(`Failed to save settings (${patchResponse.status})`);
  }

  return next;
}
