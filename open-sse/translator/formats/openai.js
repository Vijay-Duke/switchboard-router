// OpenAI helper functions for translator
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK, VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES } from "../schema/index.js";
import { collapseTextParts } from "../concerns/message.js";

// Re-export valid-type lists (moved to schema/blocks.js) to keep existing importers working.
export { VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES };

// JSON Schema keywords whose values must be integers (not strings).
// MCP tools / clients sometimes serialize numeric constraints as strings,
// which strict providers (Codex, NIM) reject. See decolua/9router PR#422.
const NUMERIC_SCHEMA_KEYWORDS = [
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "minItems", "maxItems",
  "minProperties", "maxProperties", "multipleOf",
];

/**
 * Recursively coerce string numeric values for integer-typed JSON Schema keywords.
 * Fixes errors like: Invalid schema: '64' is not of type 'integer'
 * @param {unknown} schema
 * @returns {unknown}
 */
export function coerceSchemaNumericConstraints(schema) {
  if (!schema || typeof schema !== "object") return schema;

  if (Array.isArray(schema)) {
    for (const item of schema) coerceSchemaNumericConstraints(item);
    return schema;
  }

  for (const key of NUMERIC_SCHEMA_KEYWORDS) {
    if (typeof schema[key] === "string") {
      const parsed = Number(schema[key]);
      if (!Number.isNaN(parsed)) schema[key] = parsed;
    }
  }

  for (const value of Object.values(schema)) {
    if (value && typeof value === "object") {
      coerceSchemaNumericConstraints(value);
    }
  }

  return schema;
}

// Filter messages to OpenAI standard format
// Remove: thinking, redacted_thinking, signature, and other non-OpenAI blocks
// opts.preserveCacheControl: keep cache_control on content blocks (e.g. for DashScope/alicode)
export function filterToOpenAIFormat(body, opts = {}) {
  if (!body.messages || !Array.isArray(body.messages)) return body;
  const keepCache = !!opts.preserveCacheControl;

  function stripBlock(block) {
    const { signature, cache_control, ...rest } = block;
    return keepCache && cache_control ? { ...rest, cache_control } : rest;
  }

  body.messages = body.messages.map(msg => {
    // Normalize developer role to system (many providers don't support developer)
    if (msg.role === ROLE.DEVELOPER) msg = { ...msg, role: ROLE.SYSTEM };

    // Keep tool messages as-is (OpenAI format)
    if (msg.role === ROLE.TOOL) return msg;

    // Keep assistant messages with tool_calls as-is
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) return msg;

    // Handle string content
    if (typeof msg.content === "string") return msg;

    // Handle array content
    if (Array.isArray(msg.content)) {
      const filteredContent = [];

      for (const block of msg.content) {
        // Skip thinking blocks
        if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) continue;

        // Only keep valid OpenAI content types
        if (VALID_OPENAI_CONTENT_TYPES.includes(block.type)) {
          filteredContent.push(stripBlock(block));
        } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
          // Convert tool_use to tool_calls format (handled separately)
          continue;
        } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
          // Keep tool_result but clean it
          filteredContent.push(stripBlock(block));
        }
      }
      
      // If all content was filtered, add empty text
      if (filteredContent.length === 0) {
        filteredContent.push({ type: OPENAI_BLOCK.TEXT, text: "" });
      }
      
      return { ...msg, content: collapseTextParts(filteredContent) };
    }
    
    return msg;
  });
  
  // Filter out messages with only empty text (but NEVER filter tool messages)
  body.messages = body.messages.filter(msg => {
    // Always keep tool messages
    if (msg.role === ROLE.TOOL) return true;
    // Always keep assistant messages with tool_calls
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) return true;
    
    if (typeof msg.content === "string") return msg.content.trim() !== "";
    if (Array.isArray(msg.content)) {
      return msg.content.some(b => 
        (b.type === OPENAI_BLOCK.TEXT && b.text?.trim()) ||
        b.type !== OPENAI_BLOCK.TEXT
      );
    }
    return true;
  });

  // Remove empty tools array (some providers like QWEN reject it)
  if (body.tools && Array.isArray(body.tools) && body.tools.length === 0) {
    delete body.tools;
  }

  // Normalize tools to OpenAI format (from Claude, Gemini, etc.)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    body.tools = body.tools.map(tool => {
      // Already OpenAI format — still coerce description + numeric schema constraints
      if (tool.type === OPENAI_BLOCK.FUNCTION && tool.function) {
        const fn = tool.function;
        return {
          ...tool,
          function: {
            ...fn,
            description: typeof fn.description === "string" ? fn.description : String(fn.description || ""),
            parameters: coerceSchemaNumericConstraints(fn.parameters || { type: "object", properties: {} }),
          },
        };
      }
      // Loose OpenAI shape without parent type: { function: { name, ... } }
      if (tool.function && !tool.type) {
        const fn = tool.function;
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: fn.name,
            description: typeof fn.description === "string" ? fn.description : String(fn.description || ""),
            parameters: coerceSchemaNumericConstraints(fn.parameters || { type: "object", properties: {} }),
          },
        };
      }
      
      // Claude format: {name, description, input_schema}
      if (tool.name && (tool.input_schema || tool.description)) {
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : String(tool.description || ""),
            parameters: coerceSchemaNumericConstraints(tool.input_schema || { type: "object", properties: {} })
          }
        };
      }
      
      // Gemini format: {functionDeclarations: [{name, description, parameters}]}
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map(fn => ({
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: fn.name,
            description: typeof fn.description === "string" ? fn.description : String(fn.description || ""),
            parameters: coerceSchemaNumericConstraints(fn.parameters || { type: "object", properties: {} })
          }
        }));
      }
      
      return tool;
    }).flat();
  }

  // Normalize tool_choice to OpenAI format
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const choice = body.tool_choice;
    // Claude format: {type: "auto|any|tool|none", name?: "..."}
    if (choice.type === "auto") {
      body.tool_choice = "auto";
    } else if (choice.type === "none") {
      body.tool_choice = "none";
    } else if (choice.type === "any") {
      body.tool_choice = "required";
    } else if (choice.type === "tool" && choice.name) {
      body.tool_choice = { type: OPENAI_BLOCK.FUNCTION, function: { name: choice.name } };
    }
  }

  return body;
}

