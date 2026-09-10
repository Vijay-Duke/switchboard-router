// @ts-check
/**
 * Request-path resolver mapping compatible-node models to their discovered
 * reasoning wire format. Consulted by open-sse's thinking translator (via
 * setCompatibleThinkingResolver) for providers matching
 * "openai-compatible-chat|responses-<uuid>".
 *
 * Precedence per model:
 *   1. Per-model descriptor persisted at import (customModels kv, normalized
 *      from the gateway's own /models catalog) — authoritative.
 *   2. Static docs-researched default for the node's baseUrl host.
 *   3. null → the translator falls back to static capability patterns
 *      (today's behavior).
 *
 * The DB snapshot is TTL-cached (routingCache) and refreshed on the chat hot
 * path, so the sync resolver below always has fresh-enough data without
 * touching SQLite per request.
 */
import { getProviderNodes, getCustomModels } from "@/lib/db/index.js";
import { cached, invalidateRoutingCache } from "open-sse/routing/routingCache.js";
import { setCompatibleThinkingResolver } from "open-sse/translator/concerns/thinkingUnified.js";
import {
  isValidReasoningSupport,
  staticNodeReasoningDefault,
} from "@/shared/utils/reasoningCatalog.js";

const COMPATIBLE_PREFIX = "openai-compatible-";
const CACHE_KEY = "compatible-reasoning:snapshot";
const SNAPSHOT_TTL_MS = 15_000;

/**
 * @typedef {{ nodesById: Map<string, {id: string, apiType: string, staticFormat: string|null}>, prefixToNode: Map<string, {id: string, apiType: string, staticFormat: string|null}>, byModel: Map<string, {supported: boolean, effort: "flat"|"nested"|null}> }} Snapshot
 */

/** @returns {Promise<Snapshot>} */
async function buildSnapshot() {
  const loadNodes = typeof getProviderNodes === "function"
    ? getProviderNodes({ type: "openai-compatible" })
    : Promise.resolve([]);
  const loadModels = typeof getCustomModels === "function"
    ? getCustomModels()
    : Promise.resolve([]);
  const [nodes, customModels] = await Promise.all([
    Promise.resolve(loadNodes).catch(() => []),
    Promise.resolve(loadModels).catch(() => []),
  ]);
  const nodesById = new Map();
  const prefixToNode = new Map();
  for (const node of nodes) {
    if (!node?.id || !node?.prefix) continue;
    const entry = {
      id: node.id,
      apiType: node.apiType === "responses" ? "responses" : "chat",
      staticFormat: staticNodeReasoningDefault(node.baseUrl),
    };
    nodesById.set(node.id, entry);
    prefixToNode.set(node.prefix, entry);
  }
  const byModel = new Map();
  for (const m of customModels) {
    if (!m?.providerAlias || !m?.id) continue;
    if ((m.type || "llm") !== "llm") continue;
    const node = prefixToNode.get(m.providerAlias);
    if (!node) continue;
    if (!isValidReasoningSupport(m.reasoning)) continue;
    byModel.set(`${node.id}|${m.id}`, m.reasoning);
  }
  return { nodesById, prefixToNode, byModel };
}

/** @type {Snapshot} */
let snapshot = { nodesById: new Map(), prefixToNode: new Map(), byModel: new Map() };

/**
 * Refresh the snapshot (TTL-cached; effectively free on the hot path).
 * Never throws — a failed build keeps the last good snapshot so the chat
 * path can await this unguarded.
 * @param {number} [ttlMs]
 */
export async function ensureCompatibleReasoning(ttlMs = SNAPSHOT_TTL_MS) {
  try {
    const fresh = await cached(CACHE_KEY, buildSnapshot, ttlMs);
    if (fresh) snapshot = fresh;
  } catch {
    /* keep last good snapshot */
  }
}

/** Drop the cached snapshot (called after customModels writes). */
export function invalidateCompatibleReasoningCache() {
  invalidateRoutingCache(CACHE_KEY);
}

/**
 * Sync resolver injected into the thinking translator. Never throws.
 * @param {string} provider - node id ("openai-compatible-chat-<uuid>")
 * @param {string} model - bare model id on the node
 * @returns {"openai"|"openai-nested"|"openai-responses"|"qwen"|"none"|null}
 */
function resolve(provider, model) {
  if (!provider || !provider.startsWith(COMPATIBLE_PREFIX)) return null;
  const node = snapshot.nodesById.get(provider);
  const perModel = snapshot.byModel.get(`${provider}|${model}`);
  if (perModel) return toWireFormat(perModel, node?.apiType || "chat");
  if (node?.staticFormat) return staticToWireFormat(node.staticFormat, node.apiType);
  return null;
}

/**
 * Map a discovered descriptor to a translator format for the node's apiType.
 * @param {{ supported: boolean, effort: "flat"|"nested"|null }} support
 * @param {"chat"|"responses"} apiType
 */
function toWireFormat(support, apiType) {
  if (!support.supported) return "none";
  if (apiType === "responses") return "openai-responses";
  return support.effort === "nested" ? "openai-nested" : "openai";
}

/**
 * @param {"flat"|"nested"|"qwen"|"none"} format
 * @param {"chat"|"responses"} apiType
 */
function staticToWireFormat(format, apiType) {
  if (format === "none") return "none";
  if (format === "qwen") return "qwen";
  if (apiType === "responses") return "openai-responses";
  return format === "nested" ? "openai-nested" : "openai";
}

/**
 * Look up the discovered reasoning descriptor for a compatible-node model by
 * prefix — used by the pi catalog sync to flag reasoning models. Falls back to
 * the node's static host default when nothing was captured at import.
 * Returns null when the prefix is not a compatible node (or is unknown).
 * @param {string} prefix
 * @param {string} modelId
 */
export function lookupCompatibleReasoningSupport(prefix, modelId) {
  const node = snapshot.prefixToNode.get(prefix);
  if (!node) return null;
  const perModel = snapshot.byModel.get(`${node.id}|${modelId}`);
  if (perModel) return perModel;
  if (node.staticFormat === "none") return { supported: false, effort: null };
  if (node.staticFormat) {
    // qwen = enable_thinking on/off axis — supported, but no effort spelling.
    return { supported: true, effort: node.staticFormat === "qwen" ? null : node.staticFormat };
  }
  return null;
}

// Register on first import (the chat handler imports this module).
setCompatibleThinkingResolver(resolve);
