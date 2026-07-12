import { createHash } from "crypto";

export const ASK_MARKER = "─ How is Switchboard routing?";
export const ASK_LINE = `\n\n${ASK_MARKER} Reply 1: bad · 2: fine · 3: good (or just ignore this)`;
export const ASK_SENTINEL = "How is Switchboard routing?";
export const THANKS_LINE = "Thanks — noted.";

const BUCKET_CAP = 3;
const REFILL_EVERY = 20;
const PENDING_TTL_MS = 30 * 60 * 1000;
const COOLDOWN_INTERACTIONS = 50;

/** Process-global feedback state — survives HMR and is reset by unit tests. */
const g = (global.__feedbackAsk ??= { byKey: Object.create(null), pending: [] });

function safeString(value, fallback = "") {
  try {
    return String(value ?? fallback);
  } catch {
    return fallback;
  }
}

function safeNow(value = Date.now()) {
  const now = Number(value);
  return Number.isFinite(now) ? now : Date.now();
}

function stateKey(apiKeyHash) {
  const key = safeString(apiKeyHash, "anon");
  return key || "anon";
}

function conversationKey(conversationFp) {
  const key = safeString(conversationFp, "");
  return key || "unknown";
}

function keyState(apiKeyHash) {
  if (!g.byKey || typeof g.byKey !== "object") g.byKey = Object.create(null);
  const key = stateKey(apiKeyHash);
  const existing = g.byKey[key];
  if (existing && typeof existing === "object") return existing;

  const state = {
    tokens: BUCKET_CAP,
    interactions: 0,
    lastRefillAt: 0,
    ignoredStreak: 0,
    multiplier: 1,
    cooldownUntil: 0,
    asked: Object.create(null),
  };
  g.byKey[key] = state;
  return state;
}

function sweepExpiredPending(now = Date.now()) {
  if (!Array.isArray(g.pending)) g.pending = [];

  const kept = [];
  for (const entry of g.pending) {
    const ts = Number(entry?.ts);
    if (Number.isFinite(ts) && ts + PENDING_TTL_MS < now) {
      // Expiry is conservatively treated as ignored; deletion prevents recounting.
      recordAskIgnored(entry?.apiKeyHash);
      continue;
    }
    kept.push(entry);
  }
  g.pending = kept;
}

/** Reset the process-global policy state (tests + explicit teardown). */
export function resetFeedbackAskState() {
  g.byKey = Object.create(null);
  g.pending = [];
}

/** Hash an API key without retaining its cleartext; anonymous callers share one key. */
export function hashKey(apiKey) {
  try {
    const source = apiKey == null || apiKey === "" ? "anon" : safeString(apiKey, "anon");
    return createHash("sha256").update(source || "anon").digest("hex");
  } catch {
    return createHash("sha256").update("anon").digest("hex");
  }
}

/**
 * Build a stable, non-reversible conversation identifier.
 * This hashes the FIRST user message: clients that trim or rewrite history (for
 * example, a sliding window) change the fingerprint and can miss pending-ask
 * capture/dedupe. That fragility is an accepted tradeoff behind the human-chat gate.
 */
export function conversationFingerprint(firstUserText, apiKeyHash) {
  try {
    const text = safeString(firstUserText, "");
    const key = safeString(apiKeyHash, "anon");
    return createHash("sha256").update(`${key}\n${text}`).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/** Read text from an OpenAI-compatible message content value without throwing. */
function messageText(content) {
  try {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    let text = "";
    for (const part of content) {
      if (typeof part === "string") text += part;
      else if (part?.type === "text" && typeof part.text === "string") text += part.text;
    }
    return text;
  } catch {
    return "";
  }
}

/** Summarize OpenAI user turns for feedback attribution without retaining message content. */
export function conversationInfo(messages) {
  const empty = {
    firstUserText: "",
    latestUserText: "",
    priorAssistantHasAsk: false,
    userTurns: 0,
  };
  if (!Array.isArray(messages)) return empty;

  try {
    let firstUserText = "";
    let latestUserText = "";
    let latestUserIndex = -1;
    let userTurns = 0;

    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      const text = messageText(message.content);
      if (userTurns === 0) firstUserText = text;
      latestUserText = text;
      latestUserIndex = i;
      userTurns += 1;
    }

    let priorAssistantHasAsk = false;
    for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      priorAssistantHasAsk =
        typeof message.content === "string" && message.content.includes(ASK_MARKER);
      break;
    }

    return { firstUserText, latestUserText, priorAssistantHasAsk, userTurns };
  } catch {
    return empty;
  }
}

/** Return whether a synthetic ask marker appears in string message content. */
export function messagesMentionAsk(messages) {
  if (!Array.isArray(messages)) return false;

  try {
    for (const message of messages) {
      if (typeof message?.content === "string" && message.content.includes(ASK_MARKER)) {
        return true;
      }
    }
  } catch {
    /* fail-safe */
  }
  return false;
}

/** Combine independent learning signals into a bounded ask value. */
export function computeAskValue(options) {
  try {
    const opts = options && typeof options === "object" ? options : {};
    const value =
      0.6 * Number(Boolean(opts.exploration)) +
      0.4 * Number(Boolean(opts.contested)) +
      0.3 * Number(Boolean(opts.coldCell)) +
      0.5 * Number(Boolean(opts.escalatedOrRescue)) +
      0.2 * Number(Boolean(opts.judgeUnconfident));
    return Math.min(1, value);
  } catch {
    return 0;
  }
}

/** Return whether this interaction is eligible for an unobtrusive feedback ask. */
export function passesInteractiveGate(options) {
  try {
    const opts = options && typeof options === "object" ? options : {};
    return (
      !opts.hasTools &&
      !opts.isBypass &&
      !opts.isInternal &&
      !!opts.ok2xx &&
      !!opts.hasText &&
      !opts.hasToolCalls &&
      Number(opts.userTurns) >= 2
    );
  } catch {
    return false;
  }
}

/** Record a completed user interaction and replenish the small ask budget. */
export function recordInteraction(apiKeyHash) {
  try {
    const state = keyState(apiKeyHash);
    state.interactions += 1;
    if (state.interactions - state.lastRefillAt >= REFILL_EVERY) {
      state.tokens = Math.min(BUCKET_CAP, state.tokens + 1);
      state.lastRefillAt = state.interactions;
    }
  } catch {
    /* fail-safe: feedback accounting must never affect a request */
  }
}

/** Decide whether to append a feedback ask, consuming a token only on success. */
export function decideAsk(options) {
  try {
    const opts = options && typeof options === "object" ? options : {};
    if (!opts.feedbackAskEnabled || !opts.gateOk) return false;
    const value = Number(opts.askValue) || 0;
    if (value <= 0) return false;

    const state = keyState(opts.apiKeyHash);
    const fp = conversationKey(opts.conversationFp);
    if (state.asked[fp]) return false;
    if (state.interactions < state.cooldownUntil) return false;
    if (state.tokens < 1) return false;

    const probability = value * state.multiplier;
    const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
    const roll = Number(rng());
    if (!Number.isFinite(roll) || roll >= probability) return false;

    state.tokens -= 1;
    state.asked[fp] = true;
    return true;
  } catch {
    return false;
  }
}

/** Register an answered ask, restoring normal sampling and applying a cooldown. */
export function recordAskAnswered(apiKeyHash) {
  try {
    const state = keyState(apiKeyHash);
    state.multiplier = 1;
    state.ignoredStreak = 0;
    state.cooldownUntil = state.interactions + COOLDOWN_INTERACTIONS;
  } catch {
    /* fail-safe */
  }
}

/** Register an ignored ask and reduce future sampling after repeated ignores. */
export function recordAskIgnored(apiKeyHash) {
  try {
    const state = keyState(apiKeyHash);
    state.ignoredStreak += 1;
    if (state.ignoredStreak >= 4) state.multiplier = 0.25;
    else if (state.ignoredStreak >= 2) state.multiplier = 0.5;
  } catch {
    /* fail-safe */
  }
}

/** Cheap gate for the hot path: true only when at least one ask is outstanding. */
export function hasPendingAsks() {
  return Array.isArray(g.pending) && g.pending.length > 0;
}

/** Add a pending ask so a subsequent bare rating can be attributed safely. */
export function addPendingAsk(options) {
  try {
    const opts = options && typeof options === "object" ? options : {};
    const now = Date.now();
    sweepExpiredPending(now);
    g.pending.push({
      apiKeyHash: stateKey(opts.apiKeyHash),
      conversationFp: conversationKey(opts.conversationFp),
      requestId: opts.requestId,
      ts: safeNow(opts.ts === undefined ? now : opts.ts),
    });
  } catch {
    /* fail-safe */
  }
}

/** Find the newest unexpired pending ask for a conversation, without consuming it. */
export function matchPendingAsk(apiKeyHash, conversationFp, now = Date.now()) {
  try {
    const at = safeNow(now);
    sweepExpiredPending(at);
    const key = stateKey(apiKeyHash);
    const fp = conversationKey(conversationFp);
    if (!Array.isArray(g.pending)) return null;
    for (let i = g.pending.length - 1; i >= 0; i -= 1) {
      const entry = g.pending[i];
      if (
        Number.isFinite(Number(entry?.ts)) &&
        Number(entry.ts) + PENDING_TTL_MS >= at &&
        entry.apiKeyHash === key &&
        entry.conversationFp === fp
      ) {
        return { ...entry };
      }
    }
  } catch {
    /* fail-safe */
  }
  return null;
}

/** Consume all pending entries for a conversation after finding its newest ask. */
export function consumePendingAsk(apiKeyHash, conversationFp, now = Date.now()) {
  try {
    const at = safeNow(now);
    sweepExpiredPending(at);
    const entry = matchPendingAsk(apiKeyHash, conversationFp, at);
    if (!entry) return null;
    const key = stateKey(apiKeyHash);
    const fp = conversationKey(conversationFp);
    g.pending = g.pending.filter(
      (pending) => pending?.apiKeyHash !== key || pending?.conversationFp !== fp
    );
    return entry;
  } catch {
    return null;
  }
}

/** Parse a bare 1/2/3 rating reply, allowing surrounding whitespace and punctuation. */
export function parseRatingReply(text) {
  try {
    if (typeof text !== "string") return null;
    const match = text.trim().match(/^[\s.:!]*([123])[\s.:!]*$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Convert a UI rating choice to the persisted negative/neutral/positive score. */
export function ratingFromReply(rating) {
  if (rating === 1) return -1;
  if (rating === 2) return 0;
  if (rating === 3) return 1;
  return null;
}

/**
 * Remove synthetic feedback turns before sending conversation history upstream.
 * This is pure: it does not modify the input array or its unmodified messages.
 */
export function stripAskExchange(messages) {
  if (!Array.isArray(messages)) return messages;

  try {
    const stripped = [];
    let previousWasAsk = false;

    for (const message of messages) {
      const role = message?.role;
      const content = message?.content;
      const isAssistant = role === "assistant";
      const isUser = role === "user";
      const isStringContent = typeof content === "string";
      const askIndex = isAssistant && isStringContent ? content.indexOf(ASK_MARKER) : -1;

      if (askIndex >= 0) {
        const reply = content.slice(0, askIndex).replace(/\s+$/, "");
        if (reply) stripped.push({ ...message, content: reply });
        previousWasAsk = true;
        continue;
      }

      if (isAssistant && isStringContent && content.trim() === THANKS_LINE) {
        previousWasAsk = false;
        continue;
      }

      if (isUser && isStringContent && previousWasAsk && parseRatingReply(content) !== null) {
        previousWasAsk = false;
        continue;
      }

      stripped.push(message);
      previousWasAsk = false;
    }

    return stripped;
  } catch {
    return messages.slice();
  }
}
