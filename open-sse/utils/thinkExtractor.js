// Match `<think>...</think>` (non-global — lastIndex state is shared across
// concurrent calls and would cause races). Stripping below uses the same
// pattern to avoid relying on a shared regex.
// Used for providers (e.g. MiniMax M3 OpenAI tier) that embed reasoning as
// XML tags inside `content` instead of a separate `reasoning_content` field.
// Ported from Switchboard PR#2463.

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
const PAIR_RE = new RegExp(`${OPEN_TAG}([\\s\\S]*?)${CLOSE_TAG}\\s*`);

/**
 * Extract a complete `<think>...</think>` pair from a finished content string.
 * @param {string} content
 * @returns {{ content: string, reasoning: string|null }}
 */
export function extractThinkTags(content) {
  if (typeof content !== "string") return { content, reasoning: null };
  const m = content.match(PAIR_RE);
  if (!m) return { content, reasoning: null };
  return {
    content: content.replace(new RegExp(`${OPEN_TAG}[\\s\\S]*?${CLOSE_TAG}\\s*`, "g"), "").trimStart(),
    reasoning: m[1].trim(),
  };
}

/**
 * Streaming extractor: tracks open/close tags across chunk boundaries.
 * @returns {(text: string) => { content: string, reasoning: string|null }}
 */
export function createThinkExtractor() {
  let buf = "";
  let inThink = false;
  return function process(text) {
    let reasoning = null;
    if (typeof text !== "string") return { content: text, reasoning };
    if (inThink) {
      const endIdx = text.indexOf(CLOSE_TAG);
      if (endIdx >= 0) {
        buf += text.slice(0, endIdx);
        reasoning = buf.trim();
        buf = "";
        inThink = false;
        text = text.slice(endIdx + CLOSE_TAG.length).trimStart();
      } else {
        buf += text;
        text = "";
      }
    }
    if (!inThink) {
      const startIdx = text.indexOf(OPEN_TAG);
      if (startIdx >= 0) {
        const after = text.slice(startIdx + OPEN_TAG.length);
        const endIdx = after.indexOf(CLOSE_TAG);
        if (endIdx >= 0) {
          reasoning = (reasoning ? reasoning + "\n" : "") + after.slice(0, endIdx).trim();
          text = text.slice(0, startIdx) + after.slice(endIdx + CLOSE_TAG.length).trimStart();
        } else {
          inThink = true;
          buf = after;
          text = text.slice(0, startIdx);
        }
      }
    }
    return { content: text, reasoning };
  };
}
