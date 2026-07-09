// @ts-check
/**
 * Lightweight model capability map for dashboard combos UI.
 * Fail-open: returns {} if catalog is unavailable.
 */

/**
 * @returns {Promise<Record<string, any>>}
 */
export async function getProviderModelsCatalog() {
  try {
    // Reuse provider model definitions already used by the models API.
    const { PROVIDER_MODELS } = await import("@/shared/constants/models.js");
    /** @type {Record<string, any>} */
    const map = {};
    if (!PROVIDER_MODELS || typeof PROVIDER_MODELS !== "object") return map;
    for (const [providerId, models] of Object.entries(PROVIDER_MODELS)) {
      if (!Array.isArray(models)) continue;
      for (const m of models) {
        if (!m?.id) continue;
        const full = `${providerId}/${m.id}`;
        if (m.caps) map[full] = m.caps;
        // Also index bare id for combo rows that store short names
        if (m.caps && !map[m.id]) map[m.id] = m.caps;
      }
    }
    return map;
  } catch {
    return {};
  }
}
