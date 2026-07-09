// @ts-check
/**
 * Central TanStack Query keys for dashboard data.
 * Keep stable string shapes so invalidation stays predictable.
 */

export const queryKeys = {
  endpoint: {
    all: /** @type {const} */ (["endpoint"]),
    keys: () => /** @type {const} */ (["endpoint", "keys"]),
    settings: () => /** @type {const} */ (["endpoint", "settings"]),
  },
  providers: {
    all: /** @type {const} */ (["providers"]),
    connections: () => /** @type {const} */ (["providers", "connections"]),
    nodes: () => /** @type {const} */ (["providers", "nodes"]),
  },
  combos: {
    all: /** @type {const} */ (["combos"]),
  },
  settings: {
    all: /** @type {const} */ (["settings"]),
  },
  usage: {
    stats: (/** @type {string} */ period) => /** @type {const} */ (["usage", "stats", period]),
    chart: (/** @type {string} */ period) => /** @type {const} */ (["usage", "chart", period]),
  },
};
