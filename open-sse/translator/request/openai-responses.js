/**
 * Translator: OpenAI Responses API → OpenAI Chat Completions
 * 
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { normalizeResponsesInput } from "../formats/responsesApi.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { coerceSchemaNumericConstraints } from "../formats/openai.js";

// Responses API enforces max 64 chars on call_id (#393)
const MAX_CALL_ID_LEN = 64;
const clampCallId = (id) => (typeof id === "string" && id.length > MAX_CALL_ID_LEN ? id.substring(0, MAX_CALL_ID_LEN) : id);

/**
 * Convert OpenAI Responses API request to OpenAI Chat Completions format
 */
export function openaiResponsesToOpenAIRequest(model, body, stream, credentials) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolResults = [];
  let pendingReasoning = "";
  let pendingEncryptedReasoning = "";

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  // Extract reasoning text from summary[].text or encrypted_content fallback
  const extractReasoningText = (item) => {
    if (Array.isArray(item.summary)) {
      const txt = item.summary.map(s => s?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    if (Array.isArray(item.content)) {
      const txt = item.content.map(c => c?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    return "";
  };

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url,
      // input_file → file (wave15)
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (!c || typeof c !== "object") return null;
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            if (c.image_url) {
              const url = typeof c.image_url === "object" ? c.image_url.url : c.image_url;
              return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
            }
            if (c.file_id) {
              return {
                type: OPENAI_BLOCK.FILE,
                file: { file_id: c.file_id, ...(c.filename ? { filename: c.filename } : {}) },
              };
            }
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: "", detail: c.detail || "auto" } };
          }
          if (c.type === RESPONSES_ITEM.INPUT_FILE) {
            const fileData = c.file_data || c.data || c.file_url || c.file_id || "";
            return {
              type: OPENAI_BLOCK.FILE,
              file: {
                ...(fileData ? { file_data: fileData } : {}),
                ...(c.filename ? { filename: c.filename } : {}),
                ...(c.file_id && !c.file_data && !c.data ? { file_id: c.file_id } : {}),
              },
            };
          }
          return c;
        }).filter(Boolean)
        : item.content;
      const msg = { role: item.role, content };
      // Attach buffered reasoning to assistant turn (required by xiaomi-mimo thinking mode)
      if (item.role === ROLE.ASSISTANT && pendingReasoning) {
        msg.reasoning_content = pendingReasoning;
      }
      if (item.role === ROLE.ASSISTANT && pendingEncryptedReasoning) {
        msg.encrypted_content = pendingEncryptedReasoning;
      }
      pendingReasoning = "";
      pendingEncryptedReasoning = "";
      result.messages.push(msg);
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Skip items with empty/missing name — Codex/OpenAI reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;

      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
        if (pendingReasoning) {
          currentAssistantMsg.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }
        if (pendingEncryptedReasoning) {
          currentAssistantMsg.encrypted_content = pendingEncryptedReasoning;
          pendingEncryptedReasoning = "";
        }
      } else {
        // Reasoning arrived between two function_call items — attach to the
        // already-open assistant message instead of dropping it.
        if (pendingReasoning) {
          currentAssistantMsg.reasoning_content = currentAssistantMsg.reasoning_content
            ? `${currentAssistantMsg.reasoning_content}\n${pendingReasoning}`
            : pendingReasoning;
          pendingReasoning = "";
        }
        if (pendingEncryptedReasoning) {
          currentAssistantMsg.encrypted_content = pendingEncryptedReasoning;
          pendingEncryptedReasoning = "";
        }
      }
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {})
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush any pending tool results first
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }
      // Add tool result immediately
      result.messages.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Buffer reasoning text; attached to next assistant message/function_call
      const txt = extractReasoningText(item);
      if (txt) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${txt}` : txt;
      if (typeof item.encrypted_content === "string") pendingEncryptedReasoning = item.encrypted_content;
      continue;
    }
  }

  // Flush remaining. Trailing reasoning (no following assistant turn) joins
  // the last assistant message so the thought is not lost at end-of-input.
  // With no assistant message at all, carry it on a minimal assistant turn —
  // downstream translators map reasoning_content to thinking blocks.
  if (pendingReasoning || pendingEncryptedReasoning) {
    const target = currentAssistantMsg
      || [...result.messages].reverse().find((m) => m.role === ROLE.ASSISTANT);
    if (target) {
      if (pendingReasoning) {
        target.reasoning_content = target.reasoning_content
          ? `${target.reasoning_content}\n${pendingReasoning}`
          : pendingReasoning;
      }
      if (pendingEncryptedReasoning) {
        target.encrypted_content = pendingEncryptedReasoning;
      }
    } else {
      const orphan = { role: ROLE.ASSISTANT, content: "" };
      if (pendingReasoning) orphan.reasoning_content = pendingReasoning;
      if (pendingEncryptedReasoning) orphan.encrypted_content = pendingEncryptedReasoning;
      result.messages.push(orphan);
    }
    pendingReasoning = "";
    pendingEncryptedReasoning = "";
  }
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Convert tools format.
  // Responses API supports "hosted" tools (e.g. { type: "request_user_input" }) that carry no
  // explicit `name` field and cannot be represented as Chat Completions function declarations.
  // Filter them out to avoid sending nameless functionDeclarations to downstream providers
  // such as Gemini, which strictly validates function names.
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools
      .map(tool => {
        // Already in Chat Completions format: { type: "function", function: { name, ... } }
        if (tool.function) return tool;
        // Responses API function tool: { type: "function", name, description, parameters }
        // Only convert when a non-empty name is present; skip hosted tools without one.
        // Hybrid clients send Claude-shaped tools ({ name, input_schema }) — accept those too.
        const name = tool.name;
        if (!name || typeof name !== "string" || name.trim() === "") return null;
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name,
            description: typeof tool.description === "string" ? tool.description : String(tool.description || ""),
            parameters: coerceSchemaNumericConstraints(normalizeToolParameters(tool.parameters ?? tool.input_schema)),
            strict: tool.strict
          }
        };
      })
      .filter(Boolean);
  }

  // Cleanup Responses API specific fields
  // Map Responses-only max_output_tokens to Chat max_tokens (avoid leaking unknown field upstream)
  if (result.max_output_tokens !== undefined) {
    if (result.max_tokens === undefined) result.max_tokens = result.max_output_tokens;
    delete result.max_output_tokens;
  }

  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}

/**
 * Ensure object schema always has properties field (required by Codex Responses API)
 */
function normalizeToolParameters(params) {
  if (!params) return { type: "object", properties: {} };
  if (params.type === "object" && !params.properties) return { ...params, properties: {} };
  return params;
}

/**
 * Convert OpenAI Chat Completions to OpenAI Responses API format
 */
export function openaiToOpenAIResponsesRequest(model, body, stream, credentials) {
  // Respect client stream flag (GitHub /responses previously always forced true,
  // breaking non-stream clients that then tried to JSON.parse SSE). Wave 6.
  const wantStream = stream !== false;

  // Body already in Responses API format (e.g. Cursor CLI calling /chat/completions with input[])
  if (body.input) return { ...body, model, stream: wantStream };

  const result = {
    model,
    input: [],
    stream: wantStream,
    store: false
  };

  // Extract system/developer messages as instructions — accumulate ALL of
  // them (agent harnesses send multi-part system prompts), extracting text
  // from array content like the message branch does.
  const instructionParts = [];
  const messages = body.messages || [];
  const extractInstructionText = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (!c || typeof c !== "object") return "";
          if (typeof c.text === "string") return c.text;
          if (typeof c.content === "string") return c.content;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  };

  for (const msg of messages) {
    if (msg.role === ROLE.SYSTEM || msg.role === ROLE.DEVELOPER) {
      // OpenAI recommends role="developer" for GPT-5/Codex as the system-level prompt.
      const text = extractInstructionText(msg.content);
      if (text) instructionParts.push(text);
      continue; // Skip instruction messages in input
    }

    // Convert user/assistant messages to input items
    if (msg.role === ROLE.USER || msg.role === ROLE.ASSISTANT) {
      // Preserve reasoning_content as a reasoning item before the message (PR#2401).
      const encryptedReasoning = msg.encrypted_content || msg.reasoning_encrypted_content;
      if (msg.role === ROLE.ASSISTANT && (msg.reasoning_content || encryptedReasoning)) {
        result.input.push({
          type: RESPONSES_ITEM.REASONING,
          ...(msg.reasoning_content
            ? { summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: msg.reasoning_content }] }
            : {}),
          ...(encryptedReasoning ? { encrypted_content: encryptedReasoning } : {}),
        });
      }

      const contentType = msg.role === ROLE.USER ? RESPONSES_ITEM.INPUT_TEXT : RESPONSES_ITEM.OUTPUT_TEXT;
      const content = typeof msg.content === "string"
        ? [{ type: contentType, text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.map(c => {
            if (c.type === OPENAI_BLOCK.TEXT) return { type: contentType, text: c.text };
            // Convert Chat Completions image_url → Responses API input_image
            // Responses API expects: { type: "input_image", image_url: "<url string>" }
            // Chat Completions sends: { type: "image_url", image_url: { url: "...", detail: "..." } }
            if (c.type === OPENAI_BLOCK.IMAGE_URL) {
              const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
              return { type: RESPONSES_ITEM.INPUT_IMAGE, image_url: url, detail: c.image_url?.detail || "auto" };
            }
            if (c.type === RESPONSES_ITEM.INPUT_IMAGE) return c;
            // Serialize any unknown type (tool_use, tool_result, thinking, etc.) as text
            const text = c.text || c.content || JSON.stringify(c);
            return { type: contentType, text: typeof text === "string" ? text : JSON.stringify(text) };
          })
          : [];

      // Only push a message block if content is non-empty.
      // Assistant messages with only tool_calls have content: null — skip the
      // message block in that case; the tool_calls are pushed separately below.
      if (content.length > 0) {
        result.input.push({
          type: RESPONSES_ITEM.MESSAGE,
          role: msg.role,
          content
        });
      }
    }

    // Convert tool calls
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        result.input.push({
          type: RESPONSES_ITEM.FUNCTION_CALL,
          call_id: clampCallId(tc.id),
          name: tc.function?.name || "_unknown",
          arguments: tc.function?.arguments || "{}"
        });
      }
    }

    // Convert tool results - output must be a string for Responses API
    if (msg.role === ROLE.TOOL) {
      const output = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(c => c.text || JSON.stringify(c)).join("\n")
          : JSON.stringify(msg.content);
      result.input.push({
        type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
        call_id: clampCallId(msg.tool_call_id),
        output
      });
    }
  }

  // All system/developer content concatenated; empty when none (filled by executor).
  result.instructions = instructionParts.join("\n");

  // Convert tools format
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => {
      if (tool.type === OPENAI_BLOCK.FUNCTION && tool.function) {
        return {
          type: OPENAI_BLOCK.FUNCTION,
          name: tool.function.name,
          description: typeof tool.function.description === "string" ? tool.function.description : String(tool.function.description || ""),
          parameters: coerceSchemaNumericConstraints(normalizeToolParameters(tool.function.parameters)),
          strict: tool.function.strict
        };
      }
      // Loose shape: { function: { name, ... } } without parent type
      if (tool.function) {
        return {
          type: OPENAI_BLOCK.FUNCTION,
          name: tool.function.name,
          description: typeof tool.function.description === "string" ? tool.function.description : String(tool.function.description || ""),
          parameters: coerceSchemaNumericConstraints(normalizeToolParameters(tool.function.parameters)),
          strict: tool.function.strict
        };
      }
      return tool;
    });
  }

  // Pass through other relevant fields
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.reasoning !== undefined) result.reasoning = body.reasoning;
  if (body.reasoning_effort !== undefined) result.reasoning = { effort: body.reasoning_effort, summary: "auto" };
  if (body.prompt_cache_key !== undefined) result.prompt_cache_key = body.prompt_cache_key;
  // Forced-tool / parallel-call / JSON-mode intent must survive onto Responses
  // backends. (`stop` is NOT a Responses API parameter — sending it 400s.)
  if (body.parallel_tool_calls !== undefined) result.parallel_tool_calls = body.parallel_tool_calls;
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (typeof tc === "string") {
      result.tool_choice = tc;
    } else if (tc?.function?.name) {
      result.tool_choice = { type: "function", name: tc.function.name };
    } else if (tc?.type) {
      result.tool_choice = tc;
    }
  }
  if (body.response_format !== undefined) {
    const rf = body.response_format;
    if (rf?.type === "json_object") {
      result.text = { format: { type: "json_object" } };
    } else if (rf?.type === "json_schema" && rf.json_schema) {
      result.text = {
        format: {
          type: "json_schema",
          name: rf.json_schema.name || "response",
          schema: rf.json_schema.schema,
          ...(rf.json_schema.strict !== undefined && { strict: rf.json_schema.strict }),
        },
      };
    }
  }

  return result;
}

// Register both directions
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, openaiResponsesToOpenAIRequest, null);
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, openaiToOpenAIResponsesRequest, null);
