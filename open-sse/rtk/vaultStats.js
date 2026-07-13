const g = (global.__vaultStats ??= { entries: 0, hits: 0, bytesSaved: 0 });

function safeCount(value) {
  try {
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) return 0;
    return Math.trunc(count);
  } catch {
    return 0;
  }
}

function addCount(key, value) {
  try {
    const next = safeCount(g[key]) + safeCount(value);
    g[key] = Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
  } catch {}
}

export function recordVaultStore(entries, bytesSaved) {
  try {
    addCount("entries", entries);
    addCount("bytesSaved", bytesSaved);
  } catch {}
}

export function recordVaultHit(n = 1) {
  try {
    addCount("hits", n);
  } catch {}
}

export function getVaultStats() {
  try {
    return {
      entries: safeCount(g.entries),
      hits: safeCount(g.hits),
      bytesSaved: safeCount(g.bytesSaved),
    };
  } catch {
    return { entries: 0, hits: 0, bytesSaved: 0 };
  }
}

export function resetVaultStats() {
  try {
    g.entries = 0;
    g.hits = 0;
    g.bytesSaved = 0;
  } catch {}
}
