import { createHash } from "node:crypto";
import { putVaultEntry } from "../runtimeDeps.js";
import { charSafePrefix } from "../utils/truncate.js";
import { looksLikeToolError } from "./index.js";

export const VAULT_TOOL_NAME = "sb_vault_search";
const VAULT_CHUNK_CHARS = 4000;
const MAX_CHUNKS = 2000;
const PREVIEW_CHARS = 500;
export const SEARCH_RESULT_CAP_BYTES = 6 * 1024;

// sb_vault_search results are capped at SEARCH_RESULT_CAP_BYTES (6KB) and appended
// back into history as tool results. If the store threshold could drop below that
// cap, those capped results would themselves get re-vaulted on the next turn.
// Floor the effective threshold one KB above the cap so a search result can never
// re-trigger a store — this is the invariant the storeToVault docblock relies on.
export const MIN_VAULT_THRESHOLD_KB = 7;

export function clampVaultThresholdKB(kb) {
  const n = Number(kb);
  if (!Number.isFinite(n)) return MIN_VAULT_THRESHOLD_KB;
  return Math.max(MIN_VAULT_THRESHOLD_KB, n);
}

// The store walk only understands messages[] / input[] / kiro conversationState.
// Gemini-family upstreams carry tool results in contents[], which we do not yet
// externalize — v1 accepts this as a NO-OP, but a silent one hides that vaulting
// is inactive for that route, so we warn exactly once per process.
let warnedUnsupportedShape = false;

export function chunkContent(text, maxChars = VAULT_CHUNK_CHARS) {
  if (typeof text !== "string" || !text) return [];
  const cap = Math.max(1, Math.floor(Number(maxChars) || VAULT_CHUNK_CHARS));
  const chunks = [];
  let rest = text;
  let guard = 0;

  while (rest && guard++ < MAX_CHUNKS) {
    if (rest.length <= cap) {
      chunks.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n\n", cap);
    if (cut < cap * 0.5) cut = rest.lastIndexOf("\n", cap);
    if (cut < cap * 0.5) cut = -1;
    let piece = cut > 0 ? rest.slice(0, cut) : charSafePrefix(rest, cap);
    if (!piece) piece = charSafePrefix(rest, cap);
    if (!piece) break;
    chunks.push(piece);
    rest = rest.slice(piece.length);
  }

  if (rest || chunks.length === 0) return [];
  return chunks;
}

export function vaultPointer(id, content) {
  const preview = charSafePrefix(content, PREVIEW_CHARS);
  const suffix = content.length > preview.length ? "…" : "";
  return `[Switchboard vault] The full tool result (${content.length} chars) was moved to the conversation vault to save context. A preview is below. To read the rest, call the sb_vault_search tool with vault_id "${id}" and a query describing what you need.\n\n--- preview (first 500 chars) ---\n${preview}${suffix}`;
}

function makeVaultId(conversationId, content) {
  return `vlt_${createHash("sha256")
    .update(`${conversationId}\0${Date.now()}\0${Math.random()}\0${content.length}`)
    .digest("hex")
    .slice(0, 12)}`;
}

async function maybeVault(text, ctx) {
  try {
    if (typeof text !== "string") return text;
    const bytes = Buffer.byteLength(text, "utf8");
    ctx.stats.bytesBefore += bytes;
    if (bytes < ctx.thresholdBytes || looksLikeToolError(text)) {
      ctx.stats.bytesAfter += bytes;
      return text;
    }
    const id = makeVaultId(ctx.conversationId, text);
    const chunks = chunkContent(text);
    if (chunks.length === 0) {
      ctx.stats.bytesAfter += bytes;
      return text;
    }
    let stored = false;
    try {
      stored = await putVaultEntry({
        id,
        conversationId: ctx.conversationId,
        toolName: ctx.toolNameHint,
        content: text,
        chunks,
        ttlMs: ctx.ttlMs,
      });
    } catch {}
    if (!stored) {
      ctx.stats.bytesAfter += bytes;
      return text;
    }
    const pointer = vaultPointer(id, text);
    ctx.stats.bytesAfter += Buffer.byteLength(pointer, "utf8");
    ctx.stats.vaulted += 1;
    return pointer;
  } catch {
    return text;
  }
}

async function storeMessage(msg, ctx) {
  try {
    if (!msg || typeof msg !== "object" || msg.is_error === true || msg.status === "error") return;
    if (msg.type === "function_call_output") {
      if (typeof msg.output === "string") msg.output = await maybeVault(msg.output, ctx);
      else if (Array.isArray(msg.output)) {
        for (let index = 0; index < msg.output.length; index += 1) {
          const part = msg.output[index];
          if (part?.type === "input_text" && typeof part.text === "string") part.text = await maybeVault(part.text, ctx);
        }
      }
      return;
    }
    if (msg.role === "tool") {
      if (typeof msg.content === "string") msg.content = await maybeVault(msg.content, ctx);
      else if (Array.isArray(msg.content)) {
        for (let index = 0; index < msg.content.length; index += 1) {
          const part = msg.content[index];
          if (part?.type === "text" && typeof part.text === "string") part.text = await maybeVault(part.text, ctx);
        }
      }
      return;
    }
    if (!Array.isArray(msg.content)) return;
    for (let index = 0; index < msg.content.length; index += 1) {
      const block = msg.content[index];
      if (!block || block.type !== "tool_result" || block.is_error === true || block.status === "error") continue;
      if (typeof block.content === "string") block.content = await maybeVault(block.content, ctx);
      else if (Array.isArray(block.content)) {
        for (let partIndex = 0; partIndex < block.content.length; partIndex += 1) {
          const part = block.content[partIndex];
          if (part?.type === "text" && typeof part.text === "string") part.text = await maybeVault(part.text, ctx);
        }
      }
    }
  } catch {}
}

async function storeKiro(body, ctx) {
  try {
    const state = body?.conversationState;
    const messages = Array.isArray(state?.history) ? [...state.history] : [];
    if (state?.currentMessage) messages.push(state.currentMessage);
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      try {
        const results = messages[messageIndex]?.userInputMessage?.userInputMessageContext?.toolResults;
        if (!Array.isArray(results)) continue;
        for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
          const result = results[resultIndex];
          if (!result || result.is_error === true || result.status === "error" || !Array.isArray(result.content)) continue;
          for (let partIndex = 0; partIndex < result.content.length; partIndex += 1) {
            const part = result.content[partIndex];
            if (part && typeof part.text === "string") part.text = await maybeVault(part.text, ctx);
          }
        }
      } catch {}
    }
  } catch {}
}

/**
 * Externalize oversized tool results before RTK compression. R1b caps every
 * sb_vault_search result below SEARCH_RESULT_CAP_BYTES, so normal thresholds
 * do not re-vault vault-search output; preserve that cap/threshold invariant.
 */
export async function storeToVault(body, { conversationId, thresholdBytes, ttlMs, toolNameHint = null, log = null } = {}) {
  const stats = { bytesBefore: 0, bytesAfter: 0, vaulted: 0 };
  try {
    if (!body || typeof body !== "object" || typeof conversationId !== "string" || !conversationId) return stats;
    const threshold = Number(thresholdBytes);
    const duration = Number(ttlMs);
    if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(duration) || duration <= 0) return stats;
    const ctx = { conversationId, thresholdBytes: threshold, ttlMs: duration, toolNameHint, log, stats };
    if (body.conversationState) {
      await storeKiro(body, ctx);
      return stats;
    }
    const items = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null;
    if (!items) {
      if (!warnedUnsupportedShape && (Array.isArray(body?.contents) || Array.isArray(body?.request?.contents))) {
        warnedUnsupportedShape = true;
        log?.warn?.("VAULT", "inactive for this upstream body shape (e.g. Gemini contents[]); tool results are not externalized");
      }
      return stats;
    }
    for (let index = 0; index < items.length; index += 1) await storeMessage(items[index], ctx);
    return stats;
  } catch {
    return { bytesBefore: 0, bytesAfter: 0, vaulted: 0 };
  }
}
