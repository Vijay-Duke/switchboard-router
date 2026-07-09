// Tool call helper functions for translator

// Anthropic tool_use.id must match: ^[a-zA-Z0-9_-]+$
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Fallback streaming tool_call id when provider omits one (index optional)
export function fallbackToolCallId(index) {
  return index === undefined ? `call_${Date.now()}` : `call_${index}_${Date.now()}`;
}

// Generate deterministic tool call ID from position + tool name (cache-friendly)
export function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName = "") {
  const name = toolName ? `_${toolName.replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

// Sanitize ID to match Anthropic pattern: keep only alphanumeric, underscore, hyphen
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Ensure all tool_calls have valid id field and arguments is string.
 * When an assistant tool_call id is remapped, tool messages that reference the
 * old id must use the same new id — regenerating independently desyncs pairs.
 */
export function ensureToolCallIds(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  /** @type {Map<string, string>} */
  const idRemap = new Map();

  // Pass 1: assistant tool_calls + Claude tool_use
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j];
        const oldId = tc.id;
        if (!tc.id || !TOOL_ID_PATTERN.test(tc.id)) {
          const sanitized = sanitizeToolId(tc.id);
          const newId = sanitized || generateToolCallId(i, j, tc.function?.name);
          if (oldId && oldId !== newId) idRemap.set(oldId, newId);
          tc.id = newId;
        }
        if (!tc.type) tc.type = "function";
        if (tc.function?.arguments && typeof tc.function.arguments !== "string") {
          tc.function.arguments = JSON.stringify(tc.function.arguments);
        }
      }
    }

    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_use" && block.id && !TOOL_ID_PATTERN.test(block.id)) {
          const oldId = block.id;
          const sanitized = sanitizeToolId(block.id);
          const newId = sanitized || generateToolCallId(i, k, block.name);
          if (oldId && oldId !== newId) idRemap.set(oldId, newId);
          block.id = newId;
        }
      }
    }
  }

  // Pass 2: tool results — apply remap first, then sanitize without inventing new ids
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (msg.role === "tool" && msg.tool_call_id) {
      if (idRemap.has(msg.tool_call_id)) {
        msg.tool_call_id = idRemap.get(msg.tool_call_id);
      } else if (!TOOL_ID_PATTERN.test(msg.tool_call_id)) {
        const sanitized = sanitizeToolId(msg.tool_call_id);
        if (sanitized) {
          if (msg.tool_call_id !== sanitized) idRemap.set(msg.tool_call_id, sanitized);
          msg.tool_call_id = sanitized;
        }
      }
    }

    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_result" && block.tool_use_id) {
          if (idRemap.has(block.tool_use_id)) {
            block.tool_use_id = idRemap.get(block.tool_use_id);
          } else if (!TOOL_ID_PATTERN.test(block.tool_use_id)) {
            const sanitized = sanitizeToolId(block.tool_use_id);
            if (sanitized) {
              if (block.tool_use_id !== sanitized) idRemap.set(block.tool_use_id, sanitized);
              block.tool_use_id = sanitized;
            }
          }
        }
      }
    }
  }

  return body;
}

// Get tool_call ids from assistant message (OpenAI format: tool_calls, Claude format: tool_use in content)
export function getToolCallIds(msg) {
  if (msg.role !== "assistant") return [];

  const ids = [];

  // OpenAI format: tool_calls array
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.id) ids.push(tc.id);
    }
  }

  // Claude format: tool_use blocks in content
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        ids.push(block.id);
      }
    }
  }

  return ids;
}

// Check if user message has tool_result for given ids (OpenAI format: role=tool, Claude format: tool_result in content)
export function hasToolResults(msg, toolCallIds) {
  if (!msg || !toolCallIds.length) return false;

  // OpenAI format: role = "tool" with tool_call_id
  if (msg.role === "tool" && msg.tool_call_id) {
    return toolCallIds.includes(msg.tool_call_id);
  }

  // Claude format: tool_result blocks in user message content
  if (msg.role === "user" && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && toolCallIds.includes(block.tool_use_id)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Fix missing tool responses for multi-tool turns.
 * OpenAI histories use consecutive role:tool messages — scan the full contiguous
 * run and only insert stubs for ids that were not answered (wave7).
 * Claude-shaped assistants (tool_use blocks) get user tool_result stubs so
 * prepareClaudeRequest keeps the pairs (wave11).
 */
export function fixMissingToolResponses(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const messages = body.messages;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const toolCallIds = getToolCallIds(msg);
    if (toolCallIds.length === 0) continue;

    const isClaudeAssistant = Array.isArray(msg.content)
      && msg.content.some((b) => b?.type === "tool_use");

    // Collect responses that IMMEDIATELY follow this assistant message
    const respondedIds = new Set();
    let insertPosition = i + 1;
    let j = i + 1;

    // OpenAI: contiguous role:tool messages
    while (j < messages.length && messages[j]?.role === "tool") {
      if (messages[j].tool_call_id) respondedIds.add(messages[j].tool_call_id);
      insertPosition = j + 1;
      j++;
    }

    // Claude: next user message may pack multiple tool_result blocks
    if (j < messages.length && messages[j]?.role === "user" && Array.isArray(messages[j].content)) {
      const content = messages[j].content;
      let hasResult = false;
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          respondedIds.add(block.tool_use_id);
          hasResult = true;
        }
      }
      if (hasResult) insertPosition = j + 1;
    }

    const missingIds = toolCallIds.filter((id) => id && !respondedIds.has(id));
    if (missingIds.length === 0) continue;

    if (isClaudeAssistant) {
      // Insert a user message with tool_result blocks (Anthropic shape)
      const next = messages[insertPosition];
      if (next?.role === "user" && Array.isArray(next.content)) {
        for (const id of missingIds) {
          next.content.push({ type: "tool_result", tool_use_id: id, content: "" });
        }
      } else {
        messages.splice(insertPosition, 0, {
          role: "user",
          content: missingIds.map((id) => ({ type: "tool_result", tool_use_id: id, content: "" })),
        });
        i = insertPosition;
      }
    } else {
      const stubs = missingIds.map((id) => ({
        role: "tool",
        tool_call_id: id,
        content: "",
      }));
      messages.splice(insertPosition, 0, ...stubs);
      i = insertPosition + stubs.length - 1;
    }
  }

  return body;
}

/**
 * Strip orphaned tool results — results that reference a tool call no longer
 * present in the same request. Mutates body in-place. Returns count removed.
 * decolua/9router PR#2298 / #2236.
 */
export function stripOrphanedToolResults(body) {
  if (!body || typeof body !== "object") return 0;
  let stripped = 0;

  if (Array.isArray(body.messages)) {
    const liveIds = new Set();
    for (const msg of body.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id) liveIds.add(tc.id);
        }
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id) liveIds.add(block.id);
        }
      }
    }

    const beforeMsgs = body.messages.length;
    body.messages = body.messages.filter(msg => {
      if (msg.role === "tool" && msg.tool_call_id) {
        return liveIds.has(msg.tool_call_id);
      }
      return true;
    });
    stripped += beforeMsgs - body.messages.length;

    for (const msg of body.messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const beforeBlocks = msg.content.length;
        msg.content = msg.content.filter(block => {
          if (block.type === "tool_result" && block.tool_use_id) {
            return liveIds.has(block.tool_use_id);
          }
          return true;
        });
        stripped += beforeBlocks - msg.content.length;
      }
    }
  }

  if (Array.isArray(body.input)) {
    const liveIds = new Set();
    for (const item of body.input) {
      if (item.type === "function_call" && item.call_id) liveIds.add(item.call_id);
    }
    if (liveIds.size > 0 || body.input.some(i => i.type === "function_call_output")) {
      const before = body.input.length;
      body.input = body.input.filter(item => {
        if (item.type === "function_call_output" && item.call_id) {
          return liveIds.has(item.call_id);
        }
        return true;
      });
      stripped += before - body.input.length;
    }
  }

  if (Array.isArray(body.contents)) {
    const liveIds = new Set();
    for (const turn of body.contents) {
      if (!Array.isArray(turn.parts)) continue;
      for (const part of turn.parts) {
        if (!part.functionCall) continue;
        const key = part.functionCall.id ?? part.functionCall.name;
        if (key) liveIds.add(key);
      }
    }
    if (liveIds.size > 0 || body.contents.some(t => Array.isArray(t.parts) && t.parts.some(p => p.functionResponse))) {
      for (const turn of body.contents) {
        if (!Array.isArray(turn.parts)) continue;
        const before = turn.parts.length;
        turn.parts = turn.parts.filter(part => {
          if (!part.functionResponse) return true;
          const key = part.functionResponse.id ?? part.functionResponse.name;
          return key ? liveIds.has(key) : true;
        });
        stripped += before - turn.parts.length;
      }
    }
  }

  if (body.request && Array.isArray(body.request.contents)) {
    stripped += stripOrphanedToolResults(body.request);
  }

  return stripped;
}
