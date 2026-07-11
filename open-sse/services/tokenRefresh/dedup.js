const REFRESH_RESULT_TTL_MS = 10_000;
const refreshDedupCache = new Map();

function removeCacheEntry(key, entry) {
  if (refreshDedupCache.get(key) !== entry) return;
  refreshDedupCache.delete(key);
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
}

function cacheRefreshResult(key, result) {
  const entry = {
    result,
    expiresAt: Date.now() + REFRESH_RESULT_TTL_MS,
    cleanupTimer: null,
  };
  entry.cleanupTimer = setTimeout(() => {
    if (refreshDedupCache.get(key) === entry) {
      refreshDedupCache.delete(key);
      entry.cleanupTimer = null;
    }
  }, REFRESH_RESULT_TTL_MS);
  // A cache cleanup timer should never keep the gateway process alive.
  entry.cleanupTimer.unref?.();
  refreshDedupCache.set(key, entry);
}

export async function dedupRefresh(provider, oldToken, fn, log) {
  if (!oldToken) return fn();
  const key = `${provider}:${oldToken}`;
  const hit = refreshDedupCache.get(key);
  if (hit) {
    if (hit.promise) {
      log?.info?.("TOKEN_REFRESH", `Reusing in-flight refresh for ${provider}`);
      return hit.promise;
    }
    if (hit.expiresAt > Date.now()) {
      log?.info?.("TOKEN_REFRESH", `Reusing recent refresh result for ${provider}`);
      return hit.result;
    }
    removeCacheEntry(key, hit);
  }
  const inFlight = { promise: null };
  const promise = (async () => {
    try {
      const result = await fn();
      // Only cache successful non-null results. Caching null/failed tokens for
      // 10s sticky-locks dead credentials (wave12).
      if (result && (result.accessToken || result.copilotToken || result.refreshToken)) {
        cacheRefreshResult(key, result);
      } else {
        removeCacheEntry(key, inFlight);
      }
      return result;
    } catch (err) {
      removeCacheEntry(key, inFlight);
      throw err;
    }
  })();
  inFlight.promise = promise;
  refreshDedupCache.set(key, inFlight);
  return promise;
}
