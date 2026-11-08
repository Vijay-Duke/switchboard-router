/**
 * Thought-signature store (Gemini 3+/Antigravity).
 *
 * Gemini 3+ requires every functionCall part to carry the thoughtSignature the
 * model produced when the call was first emitted. Clients (Claude Code, IDEs)
 * do not persist those signatures in their history, so we remember them here:
 * an in-RAM LRU (fast path, 1h TTL) plus an optional SQLite kv layer (7d TTL)
 * so signatures survive restarts and multi-process deployments.
 *
 * Persistence goes through the injected kv factory (M11 — open-sse never
 * statically imports the Next DB layer); when unwired the store degrades to
 * RAM-only and every kv call fails open.
 */

import { makeKvStore } from "../runtimeDeps.js";

const MAX_SIGNATURES = 2000;
const MAX_PERSISTED_SIGNATURES = 10_000;
const MEMORY_TTL_MS = 1000 * 60 * 60; // 1 hour
const PERSISTED_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SCOPE = "gemini_thought_signatures";

// Lazily-created scoped kv (created on first use so app wiring order is free).
let signatureKv;
function kv() {
  if (signatureKv === undefined) {
    try {
      signatureKv = makeKvStore(SCOPE) || null;
    } catch {
      signatureKv = null;
    }
  }
  return signatureKv;
}

const memorySignatures = new Map();
const cacheKey = (id, session) => JSON.stringify([session || null, id]);
let pruneCounter = 0;

/**
 * Model family that produced / will consume a signature. Antigravity serves Gemini and Claude
 * models behind the same API, and each backend only accepts its own signatures: a Claude
 * signature replayed to Gemini fails with 400 "Corrupted thought signature." (and vice versa).
 */
export function signatureFamily(model) {
  const m = typeof model === "string" ? model.toLowerCase() : "";
  if (!m) return null;
  if (m.includes("claude")) return "claude";
  if (m.includes("gemini")) return "gemini";
  return m;
}

// Entries stored before families were recorded (no `family`) stay usable for any model.
function isCompatible(entry, family) {
  return !entry.family || !family || entry.family === family;
}

function pruneMemoryExpired() {
  const now = Date.now();
  for (const [key, value] of memorySignatures.entries()) {
    if (value.expiresAt <= now) {
      memorySignatures.delete(key);
    }
  }

  while (memorySignatures.size > MAX_SIGNATURES) {
    const oldestKey = memorySignatures.keys().next().value;
    if (!oldestKey) break;
    memorySignatures.delete(oldestKey);
  }
}

async function maybePrunePersisted() {
  pruneCounter++;
  if (pruneCounter % 100 !== 0) return;

  const store = kv();
  if (!store?.getAll) return;

  try {
    const all = await store.getAll();
    const keys = Object.keys(all);
    const now = Date.now();
    const expiredKeys = [];
    const valid = [];

    for (const k of keys) {
      const entry = all[k];
      if (!entry || typeof entry.signature !== "string" || (entry.expiresAt && entry.expiresAt <= now)) {
        expiredKeys.push(k);
      } else {
        valid.push({ key: k, createdAt: entry.createdAt || 0 });
      }
    }

    for (const k of expiredKeys) {
      await store.remove(k).catch(() => {});
    }

    if (valid.length > MAX_PERSISTED_SIGNATURES) {
      valid.sort((a, b) => b.createdAt - a.createdAt);
      const toRemove = valid.slice(MAX_PERSISTED_SIGNATURES);
      for (const item of toRemove) {
        await store.remove(item.key).catch(() => {});
      }
    }
  } catch {
    // Fail-open
  }
}

/**
 * Store a thought signature for a tool_call_id with optional sessionId namespace (RAM + SQLite async).
 * `model` is the model that produced the signature; lookups for another model family skip it.
 */
export function storeGeminiThoughtSignature(toolCallId, signature, sessionId = null, model = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  if (typeof signature !== "string" || !signature) return;

  const now = Date.now();
  const family = signatureFamily(model);
  pruneMemoryExpired();

  const keys = [cacheKey(toolCallId, sessionId)];

  const store = kv();
  for (const k of keys) {
    memorySignatures.set(k, {
      signature,
      family,
      expiresAt: now + MEMORY_TTL_MS,
    });

    // Async persist to SQLite kv table without blocking
    store?.set?.(k, {
      signature,
      family,
      createdAt: now,
      expiresAt: now + PERSISTED_TTL_MS,
    })?.catch?.(() => {});
  }

  maybePrunePersisted().catch(() => {});
}

/**
 * Retrieve a thought signature by tool_call_id (RAM first, then SQLite fallback).
 * `model` is the target model; signatures produced by another model family are ignored.
 */
export async function getGeminiThoughtSignature(toolCallId, sessionId = null, model = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  const key = cacheKey(toolCallId, sessionId);
  const cached = getGeminiThoughtSignatureSync(toolCallId, sessionId, model);
  if (cached) return cached;
  const store = kv();
  if (!store?.get) return null;
  try {
    const row = await store.get(key);
    if (!row || typeof row.signature !== "string" || !isCompatible(row, signatureFamily(model))) return null;
    if (row.expiresAt && row.expiresAt <= Date.now()) {
      store.remove(key).catch(() => {});
      return null;
    }
    memorySignatures.set(key, { signature: row.signature, family: row.family || null,
      expiresAt: Math.min(row.expiresAt || Infinity, Date.now() + MEMORY_TTL_MS) });
    return row.signature;
  } catch { return null; }
}

/** Load persisted signatures before the synchronous request translators run. */
export async function hydrateGeminiThoughtSignatures(body, sessionId, model) {
  const ids = new Set();
  const visit = value => {
    if (!value || typeof value !== "object" || ids.size >= MAX_SIGNATURES) return;
    if (["tool_use", "function_call"].includes(value.type) && typeof value.id === "string") ids.add(value.id);
    if (Array.isArray(value.tool_calls)) for (const call of value.tool_calls) if (typeof call?.id === "string") ids.add(call.id);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(body);
  await Promise.all([...ids].map(id => getGeminiThoughtSignature(id, sessionId, model)));
}

/** Synchronous lookup in the exact client/session namespace. */
export function getGeminiThoughtSignatureSync(toolCallId, sessionId = null, model = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  pruneMemoryExpired();
  const entry = memorySignatures.get(cacheKey(toolCallId, sessionId));
  return entry && entry.expiresAt > Date.now() && isCompatible(entry, signatureFamily(model)) ? entry.signature : null;
}
