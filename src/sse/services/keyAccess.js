// Per-API-key target access control (models, combos, provider-as-model).
//
// Ported from upstream Switchboard (d8c585fb + 2aa9307f), adapted to this
// tree's key policy shape: a client key carries `allowedModels` +
// `allowedCombos` arrays instead of a single `access.allow` list, and an
// EMPTY pair of lists means unrestricted (upstream models that with a
// separate `access.restricted` flag). The union of both lists acts as the
// allow list, so existing exact-match keys keep working unchanged.
//
// Entries may be:
//   * exact names — matched case-insensitively on RESOLVED identities, so
//     every spelling that routes to the same target is one target
//     (`cx/gpt-5` ≡ `codex/gpt-5` ≡ an alias pointing there);
//   * wildcard patterns — `oc/*`, `*claude*`, `*` — matched against both the
//     canonical `providerId/model` and the requested spelling, so a pattern
//     may be written with either the provider alias or the provider id;
//   * deny entries — `!pattern` / `-pattern` — reject the target outright,
//     even when a positive rule would allow it. A bare deny term (no `*`)
//     also matches as a substring of either spelling, so `-haiku` needs no
//     asterisks. A deny-only list is open-except-denied.
//
// A combo grants its members when reached THROUGH that combo; it does not
// grant calling a member directly. The check runs before any credential
// lookup, so a denied request never touches a provider account.
//
// To block every target, use a deny-only list with a catch-all pattern
// (e.g. `!*`): with no positive entries the key is open-except-denied, and
// `*` denies everything.
import { getCombos, authenticateApiKey } from "@/lib/db/index.js";
import { getModelInfo, getComboModels } from "./model.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { extractGatewayApiKey } from "@/shared/utils/gatewayApiKey.js";

const lower = (s) => String(s).toLowerCase();
const canonicalModel = (provider, model) => lower(`${provider}/${model}`);

/**
 * The client key, read from the same places the gateway auth layer reads it
 * (Bearer, x-api-key, x-goog-api-key, x-switchboard-api-key) plus the
 * `?key=` query parameter used by Gemini-native clients.
 */
export function extractClientApiKey(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  const headerKey = extractGatewayApiKey(headers);
  if (headerKey) return headerKey;
  try {
    return new URL(request.url).searchParams.get("key") || null;
  } catch {
    return null;
  }
}

/**
 * Access context for the request's key, or null when the request is
 * unrestricted (no key, unknown key, or a key with empty allow lists).
 * Keys are only authenticated elsewhere (clientKeyPolicy); this only
 * decides what an identified key may call.
 */
export async function getKeyAccessContext(request) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return null;
  const record = await authenticateApiKey(apiKey);
  if (!record) return null;
  return buildKeyAccessContext(record);
}

/**
 * Context from an already-authenticated client-key record (the policy layer
 * path), or null when the key is unrestricted.
 */
export function buildKeyAccessContext(clientKey) {
  const allow = [
    ...(Array.isArray(clientKey?.allowedModels) ? clientKey.allowedModels : []),
    ...(Array.isArray(clientKey?.allowedCombos) ? clientKey.allowedCombos : []),
  ].map((entry) => String(entry ?? "").trim()).filter(Boolean);
  if (allow.length === 0) return null;
  return {
    keyId: clientKey.id,
    keyName: clientKey.name || clientKey.id,
    allow,
    _sets: null,
  };
}

// Wildcard pattern entries (e.g. "oc/*", "*claude*", "*") match the model's
// canonical spelling AND the requested spelling, so a pattern may be written
// with either the provider alias or the provider id. Non-wildcard entries
// are handled strictly by the canonical set checks below.
function matchesWildcardPattern(str, pattern) {
  if (!pattern || typeof pattern !== "string") return false;
  const p = pattern.trim().toLowerCase();
  if (!p.includes("*")) return false;
  if (p === "*") return true;
  const target = String(str || "").trim().toLowerCase();
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(target);
}

function anyWildcardMatches(canonical, requested, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const p of patterns) {
    if (matchesWildcardPattern(requested, p) || matchesWildcardPattern(canonical, p)) return true;
    // "alias/*" also covers the provider-id spelling (oc/* ≡ opencode/*)
    const m = /^([^/*]+)\/\*$/.exec(String(p || "").trim().toLowerCase());
    if (m) {
      const id = resolveProviderId(m[1]);
      if (id && canonical.startsWith(`${id}/`)) return true;
    }
  }
  return false;
}

// Deny entries ("!pattern" / "-pattern") reject the model outright, even when
// a positive rule would allow it. A bare deny term (no "*") also matches as a
// substring of either spelling, so "-haiku" needs no asterisks.
function isDeniedByRules(sets, requested, canonical) {
  for (const deny of sets.deny) {
    if (matchesWildcardPattern(requested, deny) || matchesWildcardPattern(canonical, deny)) return true;
    const r = String(requested || "").toLowerCase();
    const nameOnly = r.includes("/") ? r.split("/").slice(1).join("/") : r;
    if (!deny.includes("*") && (r.includes(deny) || nameOnly.includes(deny) || String(canonical || "").toLowerCase().includes(deny))) return true;
  }
  return false;
}

// Resolve the allow list once per request: combo names, resolved model ids,
// and resolved provider ids (for provider-as-model kinds).
async function getAllowSets(ctx) {
  if (ctx._sets) return ctx._sets;
  const comboNames = new Set((await getCombos()).map((c) => lower(c.name)));
  const combos = new Set();
  const models = new Set();
  const providers = new Set();
  const deny = [];
  let positives = 0;
  for (const entry of ctx.allow) {
    const trimmed = String(entry ?? "").trim();
    if ((trimmed.startsWith("!") || trimmed.startsWith("-")) && trimmed.length > 1) {
      deny.push(trimmed.slice(1).toLowerCase());
      continue;
    }
    positives += 1;
    const key = lower(entry);
    if (comboNames.has(key)) {
      combos.add(key);
      continue;
    }
    const info = await getModelInfo(entry);
    if (info?.provider && info.model) models.add(canonicalModel(info.provider, info.model));
    if (!entry.includes("/")) providers.add(lower(resolveProviderId(entry)));
  }
  // A deny-only list (no positive entries) allows everything not denied;
  // an EMPTY list still denies everything (handled earlier: empty = unrestricted).
  ctx._sets = { combos, models, providers, deny, openExceptDenied: deny.length > 0 && positives === 0 };
  return ctx._sets;
}

async function isModelStringAllowed(ctx, requested) {
  const sets = await getAllowSets(ctx);
  const info = await getModelInfo(requested);
  // provider null ⇔ an existing combo with no members (routes nowhere).
  if (!info?.provider) return sets.combos.has(lower(requested)) || sets.openExceptDenied;
  const canonical = canonicalModel(info.provider, info.model);
  if (isDeniedByRules(sets, requested, canonical)) return false;
  if (sets.openExceptDenied) return true;
  if (sets.models.has(canonical)) return true;
  return anyWildcardMatches(canonical, requested, ctx.allow);
}

/**
 * Is `requested` (a model or combo string, before combo expansion) allowed
 * for this key-access context?
 */
export async function isTargetAllowed(ctx, requested) {
  if (!ctx) return true;
  if (typeof requested !== "string" || !requested) return false;
  const sets = await getAllowSets(ctx);
  const comboModels = await getComboModels(requested);
  if (comboModels) {
    if (isDeniedByRules(sets, requested, requested)) return false;
    if (!(sets.combos.has(lower(requested)) || sets.openExceptDenied || anyWildcardMatches(requested, requested, ctx.allow))) return false;
    return !await comboContainsDenied(sets, comboModels, new Set([requested]));
  }
  return await isModelStringAllowed(ctx, requested);
}

// A granted combo includes its members, but explicit denies still apply to
// every resolved leaf. Refuse cyclic/unverifiable graphs rather than bypassing
// the policy via nested combo names.
async function comboContainsDenied(sets, members, seen, providerOnly = false) {
  for (const member of members) {
    if (typeof member !== "string" || seen.has(member)) return true;
    if (isDeniedByRules(sets, member, member)) return true;
    const nested = await getComboModels(member);
    if (nested) {
      if (await comboContainsDenied(sets, nested, new Set([...seen, member]), providerOnly)) return true;
    } else if (providerOnly) {
      if (isDeniedByRules(sets, member, resolveProviderId(member))) return true;
    } else {
      const info = await getModelInfo(member);
      if (!info?.provider || !info.model || isDeniedByRules(sets, member, canonicalModel(info.provider, info.model))) return true;
    }
  }
  return false;
}

/**
 * Is a handler-resolved provider/model allowed? A missing model (e.g. a
 * multipart video body we do not parse) is denied for restricted keys: an
 * unverifiable target is not an allowed one.
 */
export async function isResolvedTargetAllowed(ctx, requested, provider, model) {
  if (!ctx) return true;
  const label = requested || (provider ? `${provider}/${model ?? ""}` : "");
  if (!provider || !model) return false;
  const sets = await getAllowSets(ctx);
  const canonical = canonicalModel(provider, model);
  if (isDeniedByRules(sets, label, canonical)) return false;
  if (sets.models.has(canonical)) return true;
  if (anyWildcardMatches(canonical, label, ctx.allow)) return true;
  if (sets.openExceptDenied) return true;
  return false;
}

/**
 * Gate for search/fetch, where the provider IS the model.
 * @param {string[]|null} comboModels - routing's own combo resolution for `requested`
 */
export async function isProviderTargetAllowed(ctx, requested, comboModels) {
  if (!ctx) return true;
  if (typeof requested !== "string" || !requested) return false;
  const sets = await getAllowSets(ctx);
  const canonical = lower(resolveProviderId(requested));
  if (isDeniedByRules(sets, requested, canonical)) return false;
  if (comboModels) {
    if (!(sets.combos.has(lower(requested)) || sets.openExceptDenied || anyWildcardMatches(requested, requested, ctx.allow))) return false;
    return !await comboContainsDenied(sets, comboModels, new Set([requested]), true);
  }
  return sets.providers.has(canonical) || sets.openExceptDenied || anyWildcardMatches(canonical, requested, ctx.allow);
}

/**
 * /v1/models: a restricted key sees only the combos and models it may call.
 * Combo entries are tagged `owned_by: "combo"` and provider-as-model entries
 * carry an explicit `kind` (webSearch/webFetch), both set by buildModelsList.
 */
export async function filterModelsListForKey(ctx, list) {
  if (!ctx || !Array.isArray(list)) return list;
  const sets = await getAllowSets(ctx);
  const out = [];
  for (const entry of list) {
    if (!entry?.id) continue;
    if (entry.owned_by === "combo") {
      if (await isTargetAllowed(ctx, entry.id)) out.push(entry);
      continue;
    }
    const info = await getModelInfo(entry.id);
    if (!info?.provider) continue;
    if (entry.kind === "webSearch" || entry.kind === "webFetch") {
      if (!isDeniedByRules(sets, entry.id, info.provider) && (sets.providers.has(lower(info.provider)) || sets.openExceptDenied || anyWildcardMatches(entry.id, entry.id, ctx.allow))) out.push(entry);
      continue;
    }
    const canonical = canonicalModel(info.provider, info.model);
    if (isDeniedByRules(sets, entry.id, canonical)) continue;
    if (sets.models.has(canonical) || sets.openExceptDenied || anyWildcardMatches(canonical, entry.id, ctx.allow)) out.push(entry);
  }
  return out;
}
