import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getComboModels } from "../services/model.js";
import { MAX_COMBO_DEPTH } from "open-sse/config/runtimeConfig.js";

/**
 * Create a recursive Auto-worker capability resolver.
 * Dependency injection keeps the recursive union independently testable.
 */
export function createWorkerCapsResolver({
  findComboModels = getComboModels,
  findCapabilities = getCapabilitiesForModel,
} = {}) {
  return async function resolveWorkerCaps(modelStr, depth = 0) {
    if (depth > MAX_COMBO_DEPTH) return {};

    const members = await findComboModels(modelStr);
    if (!members) {
      const [provider, ...rest] = modelStr.split("/");
      const model = rest.join("/") || provider;
      return findCapabilities(provider, model) || {};
    }

    const union = { vision: false, pdf: false, tools: false };
    for (const member of members) {
      const caps = await resolveWorkerCaps(member, depth + 1);
      union.vision ||= !!caps.vision;
      union.pdf ||= !!caps.pdf;
      union.tools ||= caps.tools !== false;
    }
    return union;
  };
}

export const resolveWorkerCaps = createWorkerCapsResolver();
