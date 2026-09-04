/**
 * OpenAI → CommandCode request translator
 *
 * Upstream `/alpha/generate` schema (verified live with curl 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; system messages NOT allowed in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array of content blocks (NEVER a string)
 *  - tool_use blocks (assistant): {type:"tool-call", toolCallId, toolName, input}
 *  - tool_result blocks (role=user): {type:"tool-result", toolCallId, toolName, output}
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */
import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { randomUUID } from "crypto";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import { resolveSessionId } from "../../utils/sessionManager.js";
import { clampSampling } from "../concerns/params.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

function toContentBlocks(content) {
  if (content == null) return [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  if (typeof content === "string") return [{ type: OPENAI_BLOCK.TEXT, text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: OPENAI_BLOCK.TEXT, text: part });
      } else if (part && typeof part === "object") {
        if (part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        } else if (part.type === OPENAI_BLOCK.IMAGE_URL || part.type === OPENAI_BLOCK.IMAGE) {
          if (part.image_url?.url) {
            blocks.push({ type: "image_url", image_url: { url: part.image_url.url } });
          } else if (part.url) {
            blocks.push({ type: "image_url", image_url: { url: part.url } });
          } else if (part.source?.data) {
            blocks.push({
              type: "image",
              source: part.source
            });
          } else {
            blocks.push(part);
          }
        } else if (typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        }
      }
    }
    return blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  }
  return [{ type: OPENAI_BLOCK.TEXT, text: String(content) }];
}

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

function convertMessages(messages = []) {
  const out = [];
  const systemTexts = [];

  // First pass: tool_call_id → tool name (OpenAI tool messages carry no name;
  // without this every toolName is "" and upstream cannot match results).
  const toolCallMap = new Map();
  for (const m of messages) {
    if (m?.role === ROLE.ASSISTANT && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id && tc.function?.name) toolCallMap.set(tc.id, tc.function.name);
      }
    }
  }

  // parallel_tool_calls / top_k have no upstream equivalent and are dropped.

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;

    if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === ROLE.TOOL) {
      const value = typeof m.content === "string" ? m.content : flattenText(m.content);
      out.push({
        role: ROLE.TOOL,
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id || "",
          toolName: toolCallMap.get(m.tool_call_id) || m.name || "",
          output: { type: "text", value },
        }],
      });
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const blocks = [];
      const text = flattenText(m.content);
      // Preserve reasoning_content as a reasoning block (PR#2401 / #2400).
      if (m.reasoning_content) {
        blocks.push({ type: "reasoning", text: m.reasoning_content });
      }
      if (text) blocks.push({ type: OPENAI_BLOCK.TEXT, text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id || "",
            toolName: fn.name || "",
            input: safeParseJson(fn.arguments),
          });
        }
      }
      out.push({ role: ROLE.ASSISTANT, content: blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }] });
      continue;
    }

    out.push({ role: ROLE.USER, content: toContentBlocks(m.content) });
  }

  return { messages: out, system: systemTexts.join("\n\n") };
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const result = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
      result.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object" },
      });
    } else if (t.name && (t.input_schema || t.parameters)) {
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema || t.parameters,
      });
    }
  }
  return result.length ? result : undefined;
}

export function openaiToCommandCodeRequest(model, body, stream, credentials = null) {
  const { messages, system } = convertMessages(body.messages);
  const params = {
    model,
    messages,
    stream: stream !== false,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    temperature: body.temperature ?? 0.3,
  };

  // JSON mode has no native field — carry it as a system instruction.
  const systemParts = [];
  if (body.response_format?.type === "json_object") {
    systemParts.push("You must respond with valid JSON. Respond ONLY with a JSON object, no other text.");
  } else if (body.response_format?.type === "json_schema" && body.response_format.json_schema?.schema) {
    systemParts.push(`You must respond with valid JSON that strictly follows this JSON schema:\n${JSON.stringify(body.response_format.json_schema.schema)}\nRespond ONLY with the JSON object, no other text.`);
  }
  if (system) systemParts.push(system);
  if (systemParts.length > 0) params.system = systemParts.join("\n\n");

  // Stop sequences pass through natively.
  if (body.stop !== undefined) params.stop = body.stop;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;
  if (body.top_p != null) params.top_p = body.top_p;
  clampSampling(params);

  const today = new Date().toISOString().slice(0, 10);

  return {
    // Stable per client session/connection (a fresh UUID per request breaks
    // any upstream state keyed by thread).
    threadId: resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId: credentials?.connectionId, scope: "commandcode" }) || randomUUID(),
    memory: "",
    config: {
      workingDir: process.cwd(),
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCodeRequest, null);
