/**
 * OpenAI to Cursor Request Translator
 * Converts OpenAI messages to Cursor ask/agent format.
 *
 * Important: Cursor can loop when tool outputs are sent via protobuf tool_results
 * with partial schema mismatches. For stability, tool outputs are represented as
 * structured text blocks in user messages.
 */
import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { DEFAULT_MIN_TOKENS } from "../../config/runtimeConfig.js";

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => {
        if (!part || typeof part !== "object") return false;
        return part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string";
      })
      .map(part => part.text || "")
      .join("");
  }
  return "";
}

function sanitizeToolResultText(text) {
  // Strip non-printable control chars that can produce backend request errors
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildToolResultBlock(toolName, toolCallId, resultText) {
  const cleanResult = sanitizeToolResultText(resultText || "");
  return [
    "<tool_result>",
    `<tool_name>${escapeXml(toolName || "tool")}</tool_name>`,
    `<tool_call_id>${escapeXml(toolCallId || "")}</tool_call_id>`,
    `<result>${escapeXml(cleanResult)}</result>`,
    "</tool_result>"
  ].join("\n");
}

function normalizeToolCallId(id) {
  return typeof id === "string" ? id.split("\n")[0] : "";
}

function convertMessages(messages) {
  const result = [];
  
  // Build a map of tool_call_id -> tool name from assistant tool calls
  const toolCallMetaMap = new Map();
  const rememberToolMeta = (toolCallId, toolName) => {
    if (!toolCallId) return;
    const name = toolName || "tool";
    toolCallMetaMap.set(toolCallId, { name });
    const normalized = normalizeToolCallId(toolCallId);
    if (normalized && normalized !== toolCallId) {
      toolCallMetaMap.set(normalized, { name });
    }
  };

  for (const msg of messages) {
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        rememberToolMeta(tc.id || "", tc.function?.name || "tool");
      }
    }
    if (msg.role === ROLE.ASSISTANT && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type !== CLAUDE_BLOCK.TOOL_USE) continue;
        rememberToolMeta(part.id || "", part.name || "tool");
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === ROLE.SYSTEM) {
      result.push({
        role: ROLE.USER,
        content: `[System Instructions]\n${extractContent(msg.content)}`
      });
      continue;
    }

    if (msg.role === ROLE.TOOL) {
      const toolContent = extractContent(msg.content);
      const toolCallId = msg.tool_call_id || "";
      const toolMeta = toolCallMetaMap.get(toolCallId) || {};
      const toolName = msg.name || toolMeta.name || "tool";
      result.push({
        role: ROLE.USER,
        content: buildToolResultBlock(toolName, toolCallId, toolContent)
      });
      continue;
    }

    if (msg.role === ROLE.USER || msg.role === ROLE.ASSISTANT) {
      if (msg.role === ROLE.USER && Array.isArray(msg.content)) {
        const parts = [];
        let hasNonText = false;
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === OPENAI_BLOCK.TEXT || block.type === CLAUDE_BLOCK.TEXT) {
            if (typeof block.text === "string") {
              parts.push({ type: OPENAI_BLOCK.TEXT, text: block.text || "" });
            }
            continue;
          }
          if (block.type === OPENAI_BLOCK.IMAGE_URL) {
            hasNonText = true;
            parts.push(block);
            continue;
          }
          if (block.type === CLAUDE_BLOCK.IMAGE) {
            hasNonText = true;
            if (block.source?.type === "base64" && block.source?.data) {
              parts.push({
                type: OPENAI_BLOCK.IMAGE_URL,
                image_url: { url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}` }
              });
            } else if (block.source?.type === "url" && block.source.url) {
              parts.push({
                type: OPENAI_BLOCK.IMAGE_URL,
                image_url: { url: block.source.url }
              });
            }
            continue;
          }
          if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
            const toolCallId = block.tool_use_id || "";
            const toolMeta =
              toolCallMetaMap.get(toolCallId) ||
              toolCallMetaMap.get(normalizeToolCallId(toolCallId));
            const toolName = toolMeta?.name || "tool";
            const toolContent = extractContent(block.content);
            parts.push({ type: OPENAI_BLOCK.TEXT, text: buildToolResultBlock(toolName, toolCallId, toolContent) });
          }
        }
        if (hasNonText) {
          result.push({ role: ROLE.USER, content: parts });
        } else {
          const joined = parts.map(p => p.text).filter(Boolean).join("\n");
          if (joined) result.push({ role: ROLE.USER, content: joined });
        }
        continue;
      }

      const content = extractContent(msg.content);

      if (msg.role === ROLE.ASSISTANT && msg.tool_calls && msg.tool_calls.length > 0) {
        const assistantMsg = { role: ROLE.ASSISTANT, content: content || "" };
        assistantMsg.tool_calls = msg.tool_calls.map(tc => {
          const { index, ...rest } = tc || {};
          return rest;
        });
        result.push(assistantMsg);
      } else if (msg.role === ROLE.ASSISTANT && Array.isArray(msg.content)) {
        const extractedToolCalls = msg.content
          .filter(b => b?.type === CLAUDE_BLOCK.TOOL_USE)
          .map(b => ({
            id: b.id || "",
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: b.name || "tool",
              arguments: JSON.stringify(b.input || {})
            }
          }))
          .filter(tc => tc.id);

        if (extractedToolCalls.length > 0) {
          result.push({
            role: ROLE.ASSISTANT,
            content: content || "",
            tool_calls: extractedToolCalls
          });
        } else if (content) {
          result.push({ role: ROLE.ASSISTANT, content });
        }
      } else {
        if (content) {
          result.push({ role: msg.role, content });
        }
      }
    }
  }

  return result;
}

export function openaiToCursorRequest(model, body, stream, credentials) {
  const messages = convertMessages(body.messages || []);

  // Strip fields irrelevant to Cursor (OpenAI/Anthropic-specific)
  const { user, metadata, tool_choice, stream_options, system, ...rest } = body;
  const maxTokens = typeof body.max_tokens === "number"
    ? body.max_tokens
    : (typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : DEFAULT_MIN_TOKENS);

  return {
    ...rest,
    messages,
    max_tokens: maxTokens,
  };
}

register(FORMATS.OPENAI, FORMATS.CURSOR, openaiToCursorRequest, null);
