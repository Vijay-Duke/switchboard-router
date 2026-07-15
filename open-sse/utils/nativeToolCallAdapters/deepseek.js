/**
 * DeepSeek Native Tool Call Adapter
 *
 * Parses DeepSeek's native tool-call token format from text responses.
 * Supports two formats:
 *
 * 1. Legacy (DeepSeek V3, R1, Composer 2.x):
 *    <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>name
 *    ```json
 *    {"arg": "value"}
 *    ```<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *
 * 2. DSML (DeepSeek V4):
 *    <｜DSML｜tool_calls>
 *    <｜DSML｜invoke name="function_name">
 *    <｜DSML｜parameter name="param" string="true">value
 *    </｜DSML｜invoke>
 */

import { generateToolCallId } from "../../translator/concerns/toolCall.js";

// ─── Detection Patterns ──────────────────────────────────────────────────────

// Legacy format markers (fullwidth bar ｜ + block character ▁)
const LEGACY_CALLS_BEGIN = "<｜tool▁calls▁begin｜>";
const LEGACY_CALL_BEGIN = "<｜tool▁call▁begin｜>";
const LEGACY_TOOL_SEP = "<｜tool▁sep｜>";
const LEGACY_CALL_END = "<｜tool▁call▁end｜>";
const LEGACY_CALLS_END = "<｜tool▁calls▁end｜>";

// DSML format markers
const DSML_TOOL_CALLS = "<｜DSML｜tool_calls>";

// Combined detection regex — fast check for either format
const DETECT_REGEX = /(<｜tool▁calls▁begin｜>|<｜DSML｜tool_calls>)/;

// ─── Legacy Format Parser ────────────────────────────────────────────────────

/**
 * Parse a single tool call block in legacy format.
 * Format: <｜tool▁call▁begin｜>function<｜tool▁sep｜>name\n```json\n{...}\n```<｜tool▁call▁end｜>
 */
function parseLegacyToolCall(block, index) {
  // Strip the outer markers
  let inner = block;
  if (inner.startsWith(LEGACY_CALL_BEGIN)) {
    inner = inner.slice(LEGACY_CALL_BEGIN.length);
  }
  if (inner.endsWith(LEGACY_CALL_END)) {
    inner = inner.slice(0, -LEGACY_CALL_END.length);
  }

  // Split on tool separator: "function<｜tool▁sep｜>name\n..."
  const sepIdx = inner.indexOf(LEGACY_TOOL_SEP);
  if (sepIdx < 0) return null;

  const afterSep = inner.slice(sepIdx + LEGACY_TOOL_SEP.length);

  // Function name is the first line (or up to the first \n or ```)
  const nameEnd = afterSep.search(/[\n`]/);
  const functionName = nameEnd > 0 ? afterSep.slice(0, nameEnd).trim() : afterSep.trim();
  if (!functionName) return null;

  // Arguments are inside ```json\n...\n``` or just as text after the name
  let args = "{}";
  const jsonBlockMatch = afterSep.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    args = jsonBlockMatch[1].trim();
  } else {
    // Fallback: everything after the name that looks like JSON
    const remaining = afterSep.slice(nameEnd >= 0 ? nameEnd : 0).trim();
    if (remaining.startsWith("{") || remaining.startsWith("[")) {
      args = remaining;
    }
  }

  // Validate args is parseable JSON; if not, wrap as string
  try {
    JSON.parse(args);
  } catch {
    args = JSON.stringify({ _raw: args });
  }

  return {
    id: generateToolCallId(0, index, functionName),
    type: "function",
    function: {
      name: functionName,
      arguments: args,
    },
  };
}

/**
 * Parse all tool calls from legacy format text.
 */
function parseLegacy(text) {
  const beginIdx = text.indexOf(LEGACY_CALLS_BEGIN);
  if (beginIdx < 0) return null;

  // Content before tool calls
  const contentBefore = text.slice(0, beginIdx).trim();

  // Extract everything between begin and end markers
  let endIdx = text.indexOf(LEGACY_CALLS_END, beginIdx);
  const toolSection = endIdx >= 0
    ? text.slice(beginIdx + LEGACY_CALLS_BEGIN.length, endIdx)
    : text.slice(beginIdx + LEGACY_CALLS_BEGIN.length);

  // Content after tool calls end
  const contentAfter = endIdx >= 0
    ? text.slice(endIdx + LEGACY_CALLS_END.length).trim()
    : "";

  // Split into individual tool call blocks
  const toolCalls = [];
  const blocks = toolSection.split(LEGACY_CALL_BEGIN).filter(Boolean);

  for (let i = 0; i < blocks.length; i++) {
    let block = blocks[i];
    // Re-add the begin marker for consistent parsing
    block = LEGACY_CALL_BEGIN + block;
    const parsed = parseLegacyToolCall(block, i);
    if (parsed) toolCalls.push(parsed);
  }

  if (toolCalls.length === 0) return null;

  const content = [contentBefore, contentAfter].filter(Boolean).join("\n").trim() || null;
  return { content, toolCalls };
}

// ─── DSML Format Parser ──────────────────────────────────────────────────────

// Safety ceiling: skip DSML regex parsing on excessively long responses
// to prevent pathological backtracking on malformed input.
const DSML_MAX_LENGTH = 500_000;

/**
 * Parse DSML format tool calls (DeepSeek V4).
 * Format:
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="function_name">
 *   <｜DSML｜parameter name="param" string="true">value
 *   </｜DSML｜invoke>
 */
function parseDSML(text) {
  const beginIdx = text.indexOf(DSML_TOOL_CALLS);
  if (beginIdx < 0) return null;

  const contentBefore = text.slice(0, beginIdx).trim();
  const toolSection = text.slice(beginIdx + DSML_TOOL_CALLS.length);

  // Safety: skip regex parsing on very large payloads
  if (toolSection.length > DSML_MAX_LENGTH) return null;

  // Match invoke blocks
  const invokeRegex = /<｜DSML｜invoke\s+name="([^"]+)">([\s\S]*?)(?:<\/｜DSML｜invoke>|$)/g;
  const paramRegex = /<｜DSML｜parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)(?=<｜DSML｜parameter|<\/｜DSML｜invoke>|$)/g;

  const toolCalls = [];
  let match;

  while ((match = invokeRegex.exec(toolSection)) !== null) {
    const functionName = match[1];
    const paramsSection = match[2];

    // Parse parameters
    const params = {};
    let paramMatch;
    paramRegex.lastIndex = 0;

    while ((paramMatch = paramRegex.exec(paramsSection)) !== null) {
      const paramName = paramMatch[1];
      const isString = paramMatch[2] === "true";
      const rawValue = paramMatch[3].trim();

      if (isString) {
        params[paramName] = rawValue;
      } else {
        // JSON value
        try {
          params[paramName] = JSON.parse(rawValue);
        } catch {
          params[paramName] = rawValue;
        }
      }
    }

    toolCalls.push({
      id: generateToolCallId(0, toolCalls.length, functionName),
      type: "function",
      function: {
        name: functionName,
        arguments: JSON.stringify(params),
      },
    });
  }

  if (toolCalls.length === 0) return null;

  return { content: contentBefore || null, toolCalls };
}

// ─── Exported Adapter ────────────────────────────────────────────────────────

export const deepseekAdapter = {
  name: "deepseek",

  /**
   * Fast detection: does the text contain native DeepSeek tool-call tokens?
   */
  detect(text) {
    return DETECT_REGEX.test(text);
  },

  /**
   * Parse native tool-call tokens from text, returning clean content + tool calls.
   */
  parse(text) {
    // Try legacy format first (more common in Composer 2.x)
    const legacy = parseLegacy(text);
    if (legacy) return legacy;

    // Try DSML format (V4)
    const dsml = parseDSML(text);
    if (dsml) return dsml;

    // Should not reach here if detect() returned true, but be safe
    return null;
  },
};

export default deepseekAdapter;

