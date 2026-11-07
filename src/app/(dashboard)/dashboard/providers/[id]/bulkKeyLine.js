// @ts-check

/**
 * Parse one bulk-add line: `name|key` or a bare `key`. Muse keys are the full
 * `LLM|id|secret` string, so a line starting with `LLM|` is kept whole as the
 * key (auto-named "LLM") instead of being split into name + truncated key.
 * @param {string} line
 * @returns {{ baseName: string, apiKey: string }}
 */
export function parseBulkKeyLine(line) {
  const trimmed = String(line || "").trim();
  if (/^LLM\|/i.test(trimmed)) return { baseName: "LLM", apiKey: trimmed };
  const parts = trimmed.split("|");
  if (parts.length >= 2) {
    return { baseName: parts[0].trim() || "Key", apiKey: parts.slice(1).join("|").trim() };
  }
  return { baseName: "Key", apiKey: parts[0].trim() };
}
