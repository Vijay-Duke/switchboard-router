// Unified request lifecycle logging: colored per-session tags.
// Ported from upstream a625ea9f "refactor(log): unify request lifecycle
// logging with session-colored tags" (9Router), adapted for Switchboard.
//
// Every lifecycle line of one request (start / upstream / fallback /
// done / disconnect / error) prints the same colored tag so concurrent
// streams stay readable in the server console. Same session seed always
// maps to the same color; requests without a seed rotate through the
// palette. Server console only — never written to the SSE byte stream.

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// Resolved once at module load; unknown/missing LOG_LEVEL defaults to INFO.
const LEVEL = (() => {
  const raw = typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined;
  return LOG_LEVELS[String(raw || "").toUpperCase()] ?? LOG_LEVELS.INFO;
})();

function formatTime() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Colored-dot tags to correlate request lines by session (same session → same color)
export const REQ_TAGS = ["🟢", "🔵", "🟣", "🟡", "🟠", "🔴", "⚪", "🟤"];

// Cap seed length before hashing: bounds work on adversarially long ids.
// Color choice only — collisions past the cap are harmless.
const TAG_SEED_MAX_LEN = 128;

let tagCursor = 0;

// Allocate next rotating tag (fallback when no session seed is available)
export function nextTag() {
  const tag = REQ_TAGS[tagCursor % REQ_TAGS.length];
  tagCursor++;
  return tag;
}

// Stable tag derived from a session/connection seed: same seed always maps
// to the same color. Seeds longer than TAG_SEED_MAX_LEN are truncated.
export function tagForSession(seed) {
  const s = String(seed ?? "");
  if (!s) return nextTag();
  let h = 0;
  const n = Math.min(s.length, TAG_SEED_MAX_LEN);
  for (let i = 0; i < n; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return REQ_TAGS[Math.abs(h) % REQ_TAGS.length];
}

// Render one correlated line body: "[HH:MM:SS] tag symbol message"
function render(tag, symbol, message) {
  const t = tag ? `${tag} ` : "";
  return `[${formatTime()}] ${t}${symbol} ${message}`;
}

// Print one correlated lifecycle line; suppressed when LOG_LEVEL is WARN or above.
export function line(tag, symbol, message) {
  if (LEVEL > LOG_LEVELS.INFO) return;
  console.log(render(tag, symbol, message));
}

// Like line() but always printed regardless of LOG_LEVEL (errors must never be hidden)
export function errorLine(tag, symbol, message) {
  console.log(render(tag, symbol, message));
}
