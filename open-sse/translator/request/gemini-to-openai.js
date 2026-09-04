import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { encodeDataUri } from "../concerns/image.js";
import { collapseTextParts } from "../concerns/message.js";
import { mapGeminiToolConfigToOpenAI } from "../concerns/toolCall.js";
import { budgetToEffort } from "../concerns/thinking.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK } from "../schema/index.js";

// Assign stable ids to id-less functionCall/functionResponse parts.
// Gemini clients often omit ids; the n-th functionCall named `f` gets
// `call_f_n` (unless it carries its own id) and the n-th functionResponse
// named `f` takes the n-th call's id — positional pairing, so parallel
// same-name calls stay distinct and a call that kept an upstream id still
// pairs with an id-less response. Idempotent on re-translation.
export function assignStableFunctionIds(contents) {
  const parts = (contents || []).flatMap((c) => c?.parts || []);
  const callIds = new Map(); // name -> ids in call order
  for (const part of parts) {
    const fc = part?.functionCall;
    if (!fc?.name) continue;
    const ids = callIds.get(fc.name) || [];
    if (!fc.id) fc.id = `call_${fc.name}_${ids.length}`;
    ids.push(fc.id);
    callIds.set(fc.name, ids);
  }
  const seen = new Map(); // name -> responses seen so far
  for (const part of parts) {
    const fr = part?.functionResponse;
    if (!fr?.name) continue;
    const n = seen.get(fr.name) || 0;
    if (!fr.id) fr.id = callIds.get(fr.name)?.[n] ?? `call_${fr.name}_${n}`;
    seen.set(fr.name, n + 1);
  }
}

// Convert Gemini request to OpenAI format
export function geminiToOpenAIRequest(model, body, stream) {
  // Gemini-CLI bodies nest everything under `body.request` (same as Antigravity).
  const req = body?.request || body || {};
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Generation config
  if (req.generationConfig) {
    const config = req.generationConfig;
    if (config.maxOutputTokens) {
      const tempBody = { max_tokens: config.maxOutputTokens, tools: req.tools };
      result.max_tokens = adjustMaxTokens(tempBody);
    }
    if (config.temperature !== undefined) {
      result.temperature = config.temperature;
    }
    if (config.topP !== undefined) {
      result.top_p = config.topP;
    }
    if (config.thinkingConfig?.thinkingBudget) {
      const effort = budgetToEffort(config.thinkingConfig.thinkingBudget);
      if (effort) result.reasoning_effort = effort;
    }
  }

  // System instruction
  if (req.systemInstruction) {
    const systemText = extractGeminiText(req.systemInstruction);
    if (systemText) {
      result.messages.push({
        role: ROLE.SYSTEM,
        content: systemText
      });
    }
  }

  // Tool config (functionCallingConfig) → tool_choice, so NONE/ANY survive the pivot.
  const toolChoice = mapGeminiToolConfigToOpenAI(req);
  if (toolChoice !== undefined) {
    result.tool_choice = toolChoice;
  }

  // Convert contents to messages
  if (req.contents && Array.isArray(req.contents)) {
    assignStableFunctionIds(req.contents);
    for (const content of req.contents) {
      const converted = convertGeminiContent(content);
      if (converted) {
        result.messages.push(converted);
      }
    }
  }

  // Tools
  if (req.tools && Array.isArray(req.tools)) {
    result.tools = [];
    for (const tool of req.tools) {
      if (tool.functionDeclarations) {
        for (const func of tool.functionDeclarations) {
          result.tools.push({
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: func.name,
              description: func.description || "",
              parameters: func.parameters || { type: "object", properties: {} }
            }
          });
        }
      }
    }
  }

  return result;
}

// Convert Gemini content to OpenAI message
function convertGeminiContent(content) {
  const role = content.role === GEMINI_ROLE.USER ? ROLE.USER : ROLE.ASSISTANT;
  
  if (!content.parts || !Array.isArray(content.parts)) {
    return null;
  }

  const parts = [];
  const toolCalls = [];
  let reasoningContent = "";

  for (const part of content.parts) {
    // Thought parts → reasoning_content on the OpenAI pivot (PR#2401 / #2400).
    if (part.thought === true) {
      if (part.text !== undefined) reasoningContent += part.text;
      continue;
    }

    if (part.text !== undefined) {
      parts.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
    }

    if (part.inlineData) {
      parts.push({
        type: OPENAI_BLOCK.IMAGE_URL,
        image_url: {
          url: encodeDataUri(part.inlineData.mimeType, part.inlineData.data)
        }
      });
    }

    if (part.fileData) {
      const uri = part.fileData.fileUri || "";
      const mime = part.fileData.mimeType || "";
      if (mime.startsWith("image/")) {
        parts.push({
          type: OPENAI_BLOCK.IMAGE_URL,
          image_url: { url: uri }
        });
      } else if (uri) {
        parts.push({ type: OPENAI_BLOCK.TEXT, text: `[File: ${uri}]` });
      }
    }

    if (part.functionCall) {
      // Ids are pre-assigned per-name by assignStableFunctionIds so parallel
      // same-name calls pair with their responses; keep the name fallback.
      toolCalls.push({
        id: part.functionCall.id || `call_${part.functionCall.name}`,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
    }

    if (part.functionResponse) {
      return {
        role: ROLE.TOOL,
        tool_call_id: part.functionResponse.id || `call_${part.functionResponse.name}`,
        content: JSON.stringify(part.functionResponse.response?.result ?? part.functionResponse.response ?? {})
      };
    }
  }

  if (toolCalls.length > 0) {
    const result = { role: ROLE.ASSISTANT };
    if (parts.length > 0) {
      result.content = parts.length === 1 ? parts[0].text : parts;
    }
    if (reasoningContent) result.reasoning_content = reasoningContent;
    result.tool_calls = toolCalls;
    return result;
  }

  if (parts.length > 0 || reasoningContent) {
    const result = { role };
    if (parts.length > 0) result.content = collapseTextParts(parts);
    if (reasoningContent) result.reasoning_content = reasoningContent;
    return result;
  }

  return null;
}

// Extract text from Gemini content
function extractGeminiText(content) {
  if (typeof content === "string") return content;
  if (content.parts && Array.isArray(content.parts)) {
    return content.parts.map(p => p.text || "").filter(Boolean).join("\n");
  }
  return "";
}

// Pre-split contents that co-locate functionResponse with other parts (functionCall/text).
// convertGeminiContent early-returns on the first functionResponse and would drop siblings.
// Switchboard#2393 / PR#2394.
function geminiToOpenAIRequestFixed(model, body, stream) {
  const src = body?.request || body;
  if (!src || !Array.isArray(src.contents)) {
    return geminiToOpenAIRequest(model, body, stream);
  }

  // Split co-located functionResponse parts into their own entries IN ORIGINAL
  // ORDER (consecutive non-response parts share one entry), so turn text stays
  // with the results it belonged with.
  const splitContents = [];
  for (const content of src.contents) {
    if (!content || !Array.isArray(content.parts)) {
      splitContents.push(content);
      continue;
    }

    const hasFunctionResponse = content.parts.some(p => p && p.functionResponse);
    if (!hasFunctionResponse) {
      splitContents.push(content);
      continue;
    }

    let run = [];
    const flushRun = () => {
      if (run.length > 0) {
        splitContents.push({ ...content, parts: run });
        run = [];
      }
    };
    for (const part of content.parts) {
      if (part && part.functionResponse) {
        flushRun();
        splitContents.push({ ...content, parts: [part] });
      } else {
        run.push(part);
      }
    }
    flushRun();
  }

  return geminiToOpenAIRequest(model, { ...body, ...(body?.request ? { request: { ...src, contents: splitContents } } : { contents: splitContents }) }, stream);
}

// Register (fixed version overrides base — Map.set last wins)
register(FORMATS.GEMINI, FORMATS.OPENAI, geminiToOpenAIRequestFixed, null);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, geminiToOpenAIRequestFixed, null);
