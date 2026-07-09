// @ts-check
/**
 * Auto-generate unique model-routing prefixes for custom provider nodes.
 * Users never need to type these — derived from the display name.
 */

/**
 * @param {string} name
 * @returns {string}
 */
export function slugifyPrefix(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "custom";
}

/**
 * Pick a unique prefix from a name, avoiding collisions with existing nodes
 * and optional reserved ids (built-in providers).
 *
 * @param {string} name
 * @param {{ prefix?: string, id?: string }[]} existingNodes
 * @param {Set<string>|string[]} [reserved]
 * @param {string} [preferExisting] keep this prefix if still free (edit flows)
 * @returns {string}
 */
export function allocateUniquePrefix(name, existingNodes = [], reserved = [], preferExisting = "") {
  const reservedSet = reserved instanceof Set ? reserved : new Set(reserved || []);
  const used = new Set(
    (existingNodes || [])
      .map((n) => (n?.prefix || "").trim())
      .filter(Boolean)
  );

  if (preferExisting && !reservedSet.has(preferExisting) && !used.has(preferExisting)) {
    return preferExisting;
  }
  // When editing, the current node still holds preferExisting in `used` — allow keeping it
  if (preferExisting) {
    const othersUse = (existingNodes || []).some(
      (n) => n?.prefix === preferExisting && n?.id !== undefined
    );
    // If only this node uses it, preferExisting is fine even if in used set
    // Callers should pass nodes excluding self, or pass preferExisting explicitly.
    if (preferExisting && !reservedSet.has(preferExisting)) {
      const clash = (existingNodes || []).filter((n) => n?.prefix === preferExisting);
      if (clash.length === 0) return preferExisting;
    }
  }

  const base = slugifyPrefix(name);
  if (!reservedSet.has(base) && !used.has(base)) return base;

  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 48);
    if (!reservedSet.has(candidate) && !used.has(candidate)) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`.slice(0, 48);
}
