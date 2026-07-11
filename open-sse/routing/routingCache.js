/**
 * Short-TTL in-process cache for auto-route hot-path aggregates.
 * Invalidated on new routing events / learning version writes.
 */

const DEFAULT_TTL_MS = 15_000;

/** @type {Map<string, { expiresAt: number, value: any }>} */
const store = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>|T} loader
 * @param {number} [ttlMs]
 * @returns {Promise<T>}
 */
export async function cached(key, loader, ttlMs = DEFAULT_TTL_MS) {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await loader();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/**
 * Read a cached value without populating on miss (unlike `cached`, which stores
 * the loader result). Returns undefined on miss or expiry.
 * @param {string} key
 * @returns {any}
 */
export function readRoutingCache(key) {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) store.delete(key);
  return undefined;
}

/**
 * Store a value directly (used by the cached-route fast path).
 * @param {string} key
 * @param {any} value
 * @param {number} [ttlMs]
 */
export function writeRoutingCache(key, value, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** @param {string} [prefix] */
export function invalidateRoutingCache(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

export function statsCacheKey(comboName, days) {
  return `stats:${comboName}:${days}`;
}

export function learningCacheKey(comboName) {
  return `learning:${comboName}`;
}
