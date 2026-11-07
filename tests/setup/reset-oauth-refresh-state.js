import { beforeEach } from "vitest";

// Production keeps OAuth refresh locks and dedup results on globalThis so the
// route and instrumentation bundles share them. Tests use vi.resetModules() to
// simulate a fresh process, so empty that shared state before each test too.
// Clear in place rather than deleting: a module instance that vitest does not
// reload still holds a reference to the original maps.
beforeEach(() => {
  const state = globalThis.__switchboardOAuthRefreshState;
  state?.refreshLocks.clear();
  state?.successfulRefreshes.clear();
  const dedup = globalThis.__switchboardRefreshDedupCache;
  for (const entry of dedup?.values() ?? []) {
    if (entry?.cleanupTimer) clearTimeout(entry.cleanupTimer);
  }
  dedup?.clear();
});
