// @ts-check
/**
 * Shared Pi capability resolver (registry + optional combo union).
 * Safe to import from client bundles — no filesystem or DB access.
 */
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { effortWireLevel, getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { lookupCompatibleReasoningSupport } from "@/sse/services/compatibleReasoning.js";

const LEVEL_ORDER = ["none", "thinking", "minimal", "low", "medium", "high", "xhigh", "max"];

function unionLevels(a, b) {
  const set = new Set([...a, ...b]);
  return LEVEL_ORDER.filter((l) => set.has(l));
}

/**
 * @param {Map<string, { models?: unknown[] }>} [comboByName]
 * @returns {(fullId: string, visited?: Set<string>) => Record<string, unknown> | null}
 */
export function createPiCapsResolver(comboByName = new Map()) {
  const resolver = (fullId, visited = new Set()) => {
    try {
      const id = String(fullId || "");
      const slash = id.indexOf("/");
      if (slash <= 0) {
        if (visited.has(id)) return null;
        visited.add(id);
        const combo = comboByName.get(id);
        if (!combo || !Array.isArray(combo.models) || combo.models.length === 0) return null;
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
      const levels = getThinkingLevels(prefix, base);
      const compat = lookupCompatibleReasoningSupport(prefix, base);
      if (compat) {
        return {
          reasoning: compat.supported === true,
          contextWindow: caps.contextWindow || null,
          ...(compat.supported === true && Array.isArray(levels) && levels.length
            ? { levels, ...(caps.thinkingFormat === "openai" ? { wireLevel: effortWireLevel } : {}) }
            : {}),
        };
      }
      return {
        reasoning: caps.reasoning === true,
        contextWindow: caps.contextWindow || null,
        levels,
        ...(caps.thinkingFormat === "openai" ? { wireLevel: effortWireLevel } : {}),
      };
    } catch {
      return null;
    }
  };
  return resolver;
}
