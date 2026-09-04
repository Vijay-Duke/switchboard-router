import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { CLAUDE_SYSTEM_PROMPT } from "../../config/appConstants.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { safeParseJSON } from "../concerns/json.js";
import { parseDataUri } from "../concerns/image.js";
import { extractTextContent } from "../formats/gemini.js";
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { clampSampling } from "../concerns/params.js";
import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../config/defaultThinkingSignature.js";

// Empty prefix matches real Claude Code behavior (no tool name prefix).
// Previously "proxy_" was used but this is a detectable fingerprint difference.
const CLAUDE_OAUTH_TOOL_PREFIX = "";

// Convert OpenAI request to Claude format
// credentials optional — used to decide Claude Code system prompt injection
export function openaiToClaudeRequest(model, body, stream, credentials = null) {
  // Tool name mapping for Claude OAuth (capitalizedName → originalName)
  const toolNameMap = new Map();
  // Cap max_tokens at the model's real output ceiling (e.g. Opus 4.8 = 128000),
  // not the conservative 64000 default — otherwise a high-output model is
  // pre-clamped here before prepareClaudeRequest's model-aware step runs.
  const modelCeiling = getCapabilitiesForModel(null, model).maxOutput || undefined;
  const result = {
    model: model,
    max_tokens: adjustMaxTokens(body, modelCeiling),
    stream: stream
  };

  // Temperature
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // Sampling: Claude supports top_p/top_k natively.
  if (body.top_p !== undefined) {
    result.top_p = body.top_p;
  }
  if (body.top_k !== undefined) {
    result.top_k = body.top_k;
  }

  // Stop sequences (Claude: stop_sequences, max 4 entries).
  const stopInput = body.stop ?? body.stop_sequences;
  if (stopInput !== undefined) {
    const stops = (Array.isArray(stopInput) ? stopInput : [stopInput])
      .filter((s) => typeof s === "string" && s);
    if (stops.length > 0) {
      result.stop_sequences = stops.slice(0, 4);
    }
  }

  // Messages
  result.messages = [];
  const systemParts = [];

  if (body.messages && Array.isArray(body.messages)) {
    // Extract system messages (developer carries system prompts on GPT-5/Codex-style clients)
    for (const msg of body.messages) {
      if (msg.role === ROLE.SYSTEM || msg.role === ROLE.DEVELOPER) {
        systemParts.push(typeof msg.content === "string" ? msg.content : extractTextContent(msg.content, "\n"));
      }
    }

    // Filter out system messages for separate processing
    const nonSystemMessages = body.messages.filter(m => m.role !== ROLE.SYSTEM && m.role !== ROLE.DEVELOPER);

    // Process messages with merging logic
    // CRITICAL: tool_result must be in separate message immediately after tool_use
    let currentRole = undefined;
    let currentParts = [];

    const flushCurrentMessage = () => {
      if (currentRole && currentParts.length > 0) {
        result.messages.push({ role: currentRole, content: currentParts });
        currentParts = [];
      }
    };

    for (const msg of nonSystemMessages) {
      const newRole = (msg.role === ROLE.USER || msg.role === ROLE.TOOL) ? ROLE.USER : ROLE.ASSISTANT;
      const blocks = getContentBlocksFromMessage(msg, toolNameMap, body);
      const hasToolUse = blocks.some(b => b.type === CLAUDE_BLOCK.TOOL_USE);
      const hasToolResult = blocks.some(b => b.type === CLAUDE_BLOCK.TOOL_RESULT);

      // Separate tool_result from other content
      if (hasToolResult) {
        const toolResultBlocks = blocks.filter(b => b.type === CLAUDE_BLOCK.TOOL_RESULT);
        const otherBlocks = blocks.filter(b => b.type !== CLAUDE_BLOCK.TOOL_RESULT);

        flushCurrentMessage();

        if (toolResultBlocks.length > 0) {
          result.messages.push({ role: ROLE.USER, content: toolResultBlocks });
        }

        if (otherBlocks.length > 0) {
          currentRole = newRole;
          currentParts.push(...otherBlocks);
        }
        continue;
      }

      if (currentRole !== newRole) {
        flushCurrentMessage();
        currentRole = newRole;
      }

      currentParts.push(...blocks);

      if (hasToolUse) {
        flushCurrentMessage();
      }
    }

    flushCurrentMessage();

    // Add cache_control to last assistant message
    for (let i = result.messages.length - 1; i >= 0; i--) {
      const message = result.messages[i];
      if (message.role === ROLE.ASSISTANT && Array.isArray(message.content) && message.content.length > 0) {
        // Find the last block that can have cache_control (not thinking blocks)
        const validBlockTypes = [CLAUDE_BLOCK.TEXT, CLAUDE_BLOCK.TOOL_USE, CLAUDE_BLOCK.TOOL_RESULT, CLAUDE_BLOCK.IMAGE];
        for (let j = message.content.length - 1; j >= 0; j--) {
          const block = message.content[j];
          if (validBlockTypes.includes(block.type)) {
            block.cache_control = { type: "ephemeral" };
            break;
          }
        }
        break;
      }
    }
  }

  // Handle response_format for JSON mode
  if (body.response_format) {
    const responseFormat = body.response_format;
    if (responseFormat.type === "json_schema" && responseFormat.json_schema?.schema) {
      const schemaJson = JSON.stringify(responseFormat.json_schema.schema, null, 2);
      systemParts.push(`You must respond with valid JSON that strictly follows this JSON schema:
\`\`\`json
${schemaJson}
\`\`\`
Respond ONLY with the JSON object, no other text.`);
    } else if (responseFormat.type === "json_object") {
      systemParts.push("You must respond with valid JSON. Respond ONLY with a JSON object, no other text.");
    }
  }

  // Claude Code system prompt: only for official Anthropic OAuth (sk-ant-oat).
  // Third-party Anthropic-compatible gateways (MiniMax, etc.) reject or waste
  // tokens on "You are Claude Code…" — never inject for them. Wave 6.
  const token = credentials?.accessToken || credentials?.apiKey || "";
  const injectClaudeCodePrompt = typeof token === "string" && token.includes("sk-ant-oat");
  const claudeCodePrompt = { type: CLAUDE_BLOCK.TEXT, text: CLAUDE_SYSTEM_PROMPT };

  if (systemParts.length > 0) {
    const systemText = systemParts.join("\n");
    const userSys = { type: CLAUDE_BLOCK.TEXT, text: systemText, cache_control: { type: "ephemeral", ttl: "1h" } };
    result.system = injectClaudeCodePrompt ? [claudeCodePrompt, userSys] : [userSys];
  } else if (injectClaudeCodePrompt) {
    result.system = [claudeCodePrompt];
  }

  // Tools - convert from OpenAI format to Claude format with prefix for OAuth
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = [];
    for (const tool of body.tools) {
      // Pass-through built-in tools (e.g. web_search_20250305) without prefix or conversion
      const toolType = tool.type;
      if (toolType && toolType !== OPENAI_BLOCK.FUNCTION) {
        result.tools.push(tool);
        continue;
      }

      // Function-shaped tools arrive in two flavors from real clients:
      //   (a) openai-spec: { type: "function", function: { name, ... } }
      //   (b) legacy/loose: { function: { name, ... } }   (no parent `type`)
      // Both must yield toolData.name. Treat the bare-function shape as a
      // function tool too — Anthropic-compatible gateways (notably MiniMax M3)
      // reject payloads where this falls through with name === undefined,
      // returning upstream code (2013) "invalid tool type". See #2435 / PR#2473.
      const toolData = tool.function ?? tool;
      const originalName = toolData.name;

      // Claude OAuth requires prefixed tool names to avoid conflicts
      const toolName = CLAUDE_OAUTH_TOOL_PREFIX + originalName;

      // Store mapping for response translation (prefixed → original)
      toolNameMap.set(toolName, originalName);

      result.tools.push({
        name: toolName,
        description: typeof toolData.description === "string" ? toolData.description : String(toolData.description || ""),
        input_schema: toolData.parameters || toolData.input_schema || { type: "object", properties: {}, required: [] }
      });
    }

    if (result.tools.length > 0) {
      result.tools[result.tools.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
    }
  }

  // Tool choice
  if (body.tool_choice) {
    result.tool_choice = convertOpenAIToolChoice(body.tool_choice);
  }
  // parallel_tool_calls: false → Claude's native disable_parallel_tool_use
  // (valid on auto/any/tool; meaningless on none).
  if (body.parallel_tool_calls === false && result.tools?.length > 0 && result.tool_choice?.type !== "none") {
    result.tool_choice = { ...(result.tool_choice || { type: "auto" }), disable_parallel_tool_use: true };
  }

  // Thinking is normalized centrally by applyThinking (thinkingUnified.js) after translation.

  // Attach toolNameMap to result for response translation
  if (toolNameMap.size > 0) {
    result._toolNameMap = toolNameMap;
  }

  clampSampling(result, { maxTemperature: 1 }); // Anthropic: temperature 0–1
  return result;
}

// Convert top-level tool array content (text + images) to Claude blocks.
function convertToolArrayContent(content) {
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === OPENAI_BLOCK.TEXT && part.text) {
      out.push({ type: CLAUDE_BLOCK.TEXT, text: part.text });
    } else if (part.type === OPENAI_BLOCK.IMAGE_URL) {
      const url = part.image_url?.url;
      if (typeof url !== "string") continue;
      const parsed = parseDataUri(url);
      if (parsed) {
        out.push({
          type: CLAUDE_BLOCK.IMAGE,
          source: { type: "base64", media_type: parsed.mimeType, data: parsed.base64 }
        });
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        out.push({ type: CLAUDE_BLOCK.IMAGE, source: { type: "url", url } });
      }
    } else if (part.type === CLAUDE_BLOCK.TEXT && part.text) {
      out.push({ type: CLAUDE_BLOCK.TEXT, text: part.text });
    } else if (part.type === CLAUDE_BLOCK.IMAGE && part.source) {
      out.push({ type: CLAUDE_BLOCK.IMAGE, source: part.source });
    }
  }
  return out;
}

// Get content blocks from single message
function getContentBlocksFromMessage(msg, toolNameMap = new Map(), opts = null) {
  const blocks = [];

  if (msg.role === ROLE.TOOL) {
    // Array tool content must go through the same per-part conversion as
    // user content — raw OpenAI image_url shapes 400 upstream.
    const toolContent = Array.isArray(msg.content)
      ? convertToolArrayContent(msg.content)
      : msg.content;
    blocks.push({
      type: CLAUDE_BLOCK.TOOL_RESULT,
      tool_use_id: msg.tool_call_id,
      content: toolContent,
      ...(msg.is_error !== undefined && { is_error: Boolean(msg.is_error) })
    });
  } else if (msg.role === ROLE.USER) {
    if (typeof msg.content === "string") {
      if (msg.content) {
        blocks.push({ type: CLAUDE_BLOCK.TEXT, text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === OPENAI_BLOCK.TEXT && part.text) {
          blocks.push({ type: CLAUDE_BLOCK.TEXT, text: part.text });
        } else if (part.type === CLAUDE_BLOCK.TOOL_RESULT) {
          blocks.push({
            type: CLAUDE_BLOCK.TOOL_RESULT,
            tool_use_id: part.tool_use_id,
            content: part.content,
            ...(part.is_error && { is_error: part.is_error })
          });
        } else if (part.type === OPENAI_BLOCK.IMAGE_URL) {
          const url = part.image_url?.url;
          if (typeof url !== "string") continue; // malformed image part -> skip, don't 500
          const parsed = parseDataUri(url);
          if (parsed) {
            blocks.push({
              type: CLAUDE_BLOCK.IMAGE,
              source: { type: "base64", media_type: parsed.mimeType, data: parsed.base64 }
            });
          } else if (url.startsWith("http://") || url.startsWith("https://")) {
            blocks.push({
              type: CLAUDE_BLOCK.IMAGE,
              source: { type: "url", url }
            });
          }
        } else if (part.type === OPENAI_BLOCK.IMAGE && part.source) {
          blocks.push({ type: CLAUDE_BLOCK.IMAGE, source: part.source });
        } else if (part.type === OPENAI_BLOCK.FILE && part.file) {
          // OpenAI file block -> Claude document (PDF) or decoded text / note.
          const fileData = part.file.file_data;
          const parsed = typeof fileData === "string" ? parseDataUri(fileData) : null;
          if (parsed && parsed.mimeType === "application/pdf") {
            blocks.push({
              type: CLAUDE_BLOCK.DOCUMENT,
              source: { type: "base64", media_type: parsed.mimeType, data: parsed.base64 }
            });
          } else if (parsed && parsed.mimeType.startsWith("text/")) {
            try {
              blocks.push({
                type: CLAUDE_BLOCK.TEXT,
                text: Buffer.from(parsed.base64, "base64").toString("utf-8")
              });
            } catch {
              blocks.push({ type: CLAUDE_BLOCK.TEXT, text: `[file omitted: ${parsed.mimeType}]` });
            }
          } else if (parsed) {
            blocks.push({ type: CLAUDE_BLOCK.TEXT, text: `[file omitted: ${parsed.mimeType}]` });
          } else if (part.file.file_id) {
            blocks.push({ type: CLAUDE_BLOCK.TEXT, text: `[file omitted: ${part.file.file_id}]` });
          }
        } else if ((part.type === OPENAI_BLOCK.INPUT_AUDIO || part.type === OPENAI_BLOCK.AUDIO_URL) && (part.input_audio || part.audio_url)) {
          // Claude has no audio input — degrade to a text note, never drop the turn.
          const detail = part.input_audio?.format || part.audio_url?.url || "audio";
          blocks.push({ type: CLAUDE_BLOCK.TEXT, text: `[audio omitted: ${detail}]` });
        }
      }
    }
  } else if (msg.role === ROLE.ASSISTANT) {
    // Map OpenAI reasoning_content → Claude thinking block (PR#2401 / #2400).
    // Attach signature when present (carried via reasoning_signature) or a default
    // so prepareClaudeRequest keeps the block for native Claude OAuth.
    const hasThinkingBlock = Array.isArray(msg.content) && msg.content.some(part => part.type === CLAUDE_BLOCK.THINKING);
    if (msg.reasoning_content && !hasThinkingBlock) {
      blocks.push({
        type: CLAUDE_BLOCK.THINKING,
        thinking: msg.reasoning_content,
        signature: msg.reasoning_signature || DEFAULT_THINKING_CLAUDE_SIGNATURE,
      });
    }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === OPENAI_BLOCK.TEXT && part.text) {
          blocks.push({ type: CLAUDE_BLOCK.TEXT, text: part.text });
        } else if (part.type === OPENAI_BLOCK.IMAGE_URL) {
          // Mirror the user branch so assistant image turns survive.
          const url = part.image_url?.url;
          if (typeof url !== "string") continue;
          const parsed = parseDataUri(url);
          if (parsed) {
            blocks.push({
              type: CLAUDE_BLOCK.IMAGE,
              source: { type: "base64", media_type: parsed.mimeType, data: parsed.base64 }
            });
          } else if (url.startsWith("http://") || url.startsWith("https://")) {
            blocks.push({
              type: CLAUDE_BLOCK.IMAGE,
              source: { type: "url", url }
            });
          }
        } else if (part.type === CLAUDE_BLOCK.TOOL_USE) {
          // Tool name already has prefix from tool declarations, keep as-is
          blocks.push({ type: CLAUDE_BLOCK.TOOL_USE, id: part.id, name: part.name, input: part.input });
        } else if (part.type === CLAUDE_BLOCK.THINKING) {
          // Include thinking block but strip cache_control (not allowed on thinking blocks)
          const { cache_control, ...thinkingBlock } = part;
          blocks.push(thinkingBlock);
        }
      }
    } else if (msg.content) {
      const text = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content, "\n");
      if (text) {
        blocks.push({ type: CLAUDE_BLOCK.TEXT, text });
      }
    }

    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type === OPENAI_BLOCK.FUNCTION) {
          if (!tc.function || typeof tc.function.name !== "string") continue; // malformed tool_call -> skip, don't 500
          // Apply prefix to tool name
          const toolName = CLAUDE_OAUTH_TOOL_PREFIX + tc.function.name;
          blocks.push({
            type: CLAUDE_BLOCK.TOOL_USE,
            id: tc.id,
            name: toolName,
            // Never leave input as a raw string — Anthropic requires object (wave10).
            input: (() => {
              const parsed = safeParseJSON(tc.function.arguments, null);
              if (parsed && typeof parsed === "object") return parsed;
              if (typeof tc.function.arguments === "object" && tc.function.arguments !== null) {
                return tc.function.arguments;
              }
              return {};
            })()
          });
        }
      }
    }
  }

  return blocks;
}

// Convert OpenAI tool choice to Claude format.
// Claude only accepts tool_choice.type of "auto" | "any" | "tool" | "none";
// anything else (e.g. OpenAI's "function") triggers a 400, so we never pass an
// unrecognized type through.
const CLAUDE_TOOL_CHOICE_TYPES = new Set(["auto", "any", "tool", "none"]);

function convertOpenAIToolChoice(choice) {
  if (!choice) return { type: "auto" };

  // OpenAI string forms: "auto" | "none" | "required"
  if (typeof choice === "string") {
    if (choice === "required") return { type: "any" };
    if (choice === "none") return { type: "none" };
    if (choice === "auto") return { type: "auto" };
    return { type: "auto" }; // anything unexpected
  }

  if (typeof choice === "object") {
    // OpenAI forced tool: { type: "function", function: { name } }.
    // Checked before the native pass-through below, because the OpenAI shape
    // also carries a `.type` ("function") that Claude rejects.
    if (choice.function?.name) {
      return { type: "tool", name: choice.function.name };
    }
    // Already Claude-native — only pass through types Claude actually accepts,
    // so a malformed or unknown type can never leak into the upstream request.
    if (CLAUDE_TOOL_CHOICE_TYPES.has(choice.type)) {
      return choice;
    }
  }

  return { type: "auto" };
}

// OpenAI -> Claude format for Antigravity (without system prompt modifications)
function openaiToClaudeRequestForAntigravity(model, body, stream) {
  const result = openaiToClaudeRequest(model, body, stream);

  // Remove Claude Code system prompt, keep only user's system messages.
  // Compare against the injected constant (equality) — a substring match
  // would strip user prompts that merely quote the phrase.
  if (result.system && Array.isArray(result.system)) {
    result.system = result.system.filter(block =>
      !block.text || block.text !== CLAUDE_SYSTEM_PROMPT
    );
    if (result.system.length === 0) {
      delete result.system;
    }
  }

  // Strip prefix from tool names for Antigravity (doesn't use Claude OAuth)
  if (result.tools && Array.isArray(result.tools)) {
    result.tools = result.tools.map(tool => {
      if (tool.name && tool.name.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
        return {
          ...tool,
          name: tool.name.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
        };
      }
      return tool;
    });
  }

  // Strip prefix from tool_use in messages
  if (result.messages && Array.isArray(result.messages)) {
    result.messages = result.messages.map(msg => {
      if (!msg.content || !Array.isArray(msg.content)) {
        return msg;
      }

      const updatedContent = msg.content.map(block => {
        if (block.type === CLAUDE_BLOCK.TOOL_USE && block.name && block.name.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          return {
            ...block,
            name: block.name.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
          };
        }
        return block;
      });

      return { ...msg, content: updatedContent };
    });
  }

  return result;
}

// Export for use in other translators
export { openaiToClaudeRequestForAntigravity };

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, openaiToClaudeRequest, null);
