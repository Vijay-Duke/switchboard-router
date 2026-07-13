import { VAULT_TOOL_NAME, SEARCH_RESULT_CAP_BYTES } from "./vault.js";
import { recordVaultHit } from "./vaultStats.js";
import { searchVault } from "../runtimeDeps.js";
import { byteSafePrefix } from "../utils/truncate.js";

export const MAX_VAULT_TURNS = 5;
export const DEFAULT_SEARCH_LIMIT = 5;
export const STREAM_BUFFER_IDLE_MS = 20_000;

const UTF8_ENCODER = new TextEncoder();
const VAULT_ERROR_RE = /unknown tool|no tool named|tool not found|not a (valid|recognized) tool|is not available|error/i;
const MAX_REPAIR_MESSAGES = 1_000;
const MAX_REPAIR_CALLS = 100;

function vaultSchema() {
  return {
    type: "object",
    properties: {
      vault_id: { type: "string", description: "The vault id from the placeholder, e.g. vlt_abc123." },
      query: { type: "string", description: "What to look for in the stored content." },
    },
    required: ["query"],
  };
}

function vaultDescription() {
  return "Search the Switchboard conversation vault for the full content of a tool result that was externalized to save context. Provide the vault_id shown in the placeholder and a query describing what you need.";
}

export function openaiVaultTool() {
  return { type: "function", function: { name: VAULT_TOOL_NAME, description: vaultDescription(), parameters: vaultSchema() } };
}

export function claudeVaultTool() {
  return { name: VAULT_TOOL_NAME, description: vaultDescription(), input_schema: vaultSchema() };
}

function toolName(tool) {
  return tool?.function?.name || tool?.name || "";
}

export function injectVaultTool(body, wire) {
  try {
    if (!Array.isArray(body?.tools)) return false;
    for (let index = 0; index < body.tools.length; index += 1) {
      if (toolName(body.tools[index]) === VAULT_TOOL_NAME) return false;
    }
    if (wire === "openai") body.tools.push(openaiVaultTool());
    else if (wire === "claude") body.tools.push(claudeVaultTool());
    else return false;
    return true;
  } catch {
    return false;
  }
}

function cleanHeaders(headers, stream = false) {
  const next = new Headers(headers);
  next.delete("content-length");
  if (stream) next.delete("content-encoding");
  return next;
}

function jsonReplay(response, data) {
  return new Response(JSON.stringify(data), {
    status: response.status,
    statusText: response.statusText,
    headers: cleanHeaders(response.headers),
  });
}

function streamReplay(response, text) {
  // Vault tool conversations opt into full buffering so classification remains
  // simple and correct; normal streaming requests never take this path.
  const bytes = UTF8_ENCODER.encode(text);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: cleanHeaders(response.headers, true),
  });
}

function parseArgs(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toVaultCall(callId, args) {
  if (typeof callId !== "string" || !callId) return null;
  return { callId, query: args?.query, vaultId: args?.vault_id };
}

// A pure-vault turn may carry several sb_vault_search calls (models emit parallel
// tool calls routinely). `calls` holds every one, in order; callId/query/vaultId
// mirror the first call so older single-call consumers/tests keep working.
function buildCallResult(calls, assistantRaw) {
  if (!Array.isArray(calls) || calls.length === 0 || !assistantRaw) return null;
  // If ANY vault call lacked an id (toVaultCall → null), forward the whole turn
  // untouched rather than intercept a subset — appending results for only some
  // ids would leave the id-less tool_call orphaned on re-dispatch.
  if (calls.some((call) => !call)) return null;
  const first = calls[0];
  return { kind: "call", callId: first.callId, query: first.query, vaultId: first.vaultId, calls, assistantRaw };
}

function classifyOpenAiJson(data, replay) {
  // With n>1 choices, intercepting choice 0 would silently discard the rest.
  if (Array.isArray(data?.choices) && data.choices.length > 1) return { kind: "none", replay };
  const message = data?.choices?.[0]?.message;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const vaultCalls = [];
  let hasOtherCall = false;
  for (let index = 0; index < calls.length; index += 1) {
    if (calls[index]?.function?.name === VAULT_TOOL_NAME) {
      vaultCalls.push(toVaultCall(calls[index].id, parseArgs(calls[index].function?.arguments)));
    } else {
      hasOtherCall = true;
    }
  }
  if (vaultCalls.length === 0) return { kind: "none", replay };
  // A turn mixing vault calls with any other tool call (or user-facing text) must
  // be forwarded untouched — consuming it would strand the sibling call. Inbound
  // repair fixes the vault call's client-side error on the next request.
  if (hasOtherCall) return { kind: "mixed", replay };
  const hasText = typeof message?.content === "string" && !!message.content.trim();
  if (hasText) return { kind: "mixed", replay };
  return buildCallResult(vaultCalls, message) || { kind: "none", replay };
}

function classifyClaudeJson(data, replay) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const vaultCalls = [];
  let hasText = false;
  let hasOtherCall = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block?.type === "tool_use") {
      if (block.name === VAULT_TOOL_NAME) vaultCalls.push(toVaultCall(block.id, block.input || {}));
      else hasOtherCall = true;
    }
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) hasText = true;
  }
  if (vaultCalls.length === 0) return { kind: "none", replay };
  if (hasOtherCall || hasText) return { kind: "mixed", replay };
  return buildCallResult(vaultCalls, blocks) || { kind: "none", replay };
}

function sseData(text) {
  const values = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("data:")) continue;
    const value = lines[index].slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try { values.push(JSON.parse(value)); } catch {}
  }
  return values;
}

function classifyOpenAiSse(text, replay) {
  const calls = new Map();
  let hasText = false;
  let multiChoice = false;
  const events = sseData(text);
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const choices = Array.isArray(events[eventIndex]?.choices) ? events[eventIndex].choices : [];
    // n>1 streaming: a chunk carrying multiple choices, or any choice past
    // index 0, means other candidates exist that interception would drop.
    if (choices.length > 1) multiChoice = true;
    const choice = choices[0];
    if (Number.isInteger(choice?.index) && choice.index > 0) multiChoice = true;
    const delta = choice?.delta;
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content.trim()) hasText = true;
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
      const part = toolCalls[callIndex];
      const index = Number.isInteger(part?.index) ? part.index : callIndex;
      const existing = calls.get(index) || { id: "", name: "", arguments: "" };
      if (typeof part?.id === "string") existing.id = part.id;
      if (typeof part?.function?.name === "string") existing.name = part.function.name;
      if (typeof part?.function?.arguments === "string") existing.arguments += part.function.arguments;
      calls.set(index, existing);
    }
  }
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  const vaultCalls = [];
  const rawToolCalls = [];
  let hasOtherCall = false;
  for (const call of ordered) {
    if (call.name === VAULT_TOOL_NAME) {
      vaultCalls.push(toVaultCall(call.id, parseArgs(call.arguments)));
      rawToolCalls.push({ id: call.id, type: "function", function: { name: VAULT_TOOL_NAME, arguments: call.arguments } });
    } else {
      // Any non-vault call — INCLUDING one we could not name/parse — forces a
      // forward, so an unnamed sibling is never silently dropped.
      hasOtherCall = true;
    }
  }
  if (vaultCalls.length === 0) return { kind: "none", replay };
  if (multiChoice || hasOtherCall || hasText) return { kind: "mixed", replay };
  const assistantRaw = { role: "assistant", content: null, tool_calls: rawToolCalls };
  return buildCallResult(vaultCalls, assistantRaw) || { kind: "none", replay };
}

function classifyClaudeSse(text, replay) {
  const blocks = new Map();
  let hasText = false;
  const events = sseData(text);
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    const index = Number.isInteger(event?.index) ? event.index : 0;
    const block = event?.content_block;
    if (event?.type === "content_block_start" && block?.type === "tool_use") {
      blocks.set(index, { id: block.id || "", name: block.name || "", input: "" });
    }
    if (event?.type === "content_block_start" && block?.type === "text" && typeof block.text === "string" && block.text.trim()) hasText = true;
    if (event?.delta?.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text.trim()) hasText = true;
    if (event?.delta?.type === "input_json_delta") {
      const existing = blocks.get(index);
      if (existing && typeof event.delta.partial_json === "string") existing.input += event.delta.partial_json;
    }
  }
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  const vaultCalls = [];
  const rawBlocks = [];
  let hasOtherCall = false;
  for (const block of ordered) {
    if (block.name === VAULT_TOOL_NAME) {
      const input = parseArgs(block.input);
      vaultCalls.push(toVaultCall(block.id, input));
      rawBlocks.push({ type: "tool_use", id: block.id, name: VAULT_TOOL_NAME, input });
    } else {
      // Any non-vault tool_use, including an unnamed/unparsed one, forces a forward.
      hasOtherCall = true;
    }
  }
  if (vaultCalls.length === 0) return { kind: "none", replay };
  if (hasOtherCall || hasText) return { kind: "mixed", replay };
  return buildCallResult(vaultCalls, rawBlocks) || { kind: "none", replay };
}

function classifyData(data, wire, replay) {
  if (wire === "openai") return classifyOpenAiJson(data, replay);
  if (wire === "claude") return classifyClaudeJson(data, replay);
  return { kind: "none", replay };
}

function classifySse(text, wire, replay) {
  if (wire === "openai") return classifyOpenAiSse(text, replay);
  if (wire === "claude") return classifyClaudeSse(text, replay);
  return { kind: "none", replay };
}

async function readWithIdleTimeout(reader) {
  let timer = null;
  try {
    const timed = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("vault stream idle")), STREAM_BUFFER_IDLE_MS);
    });
    return await Promise.race([reader.read(), timed]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bufferSse(response) {
  const reader = response.clone().body?.getReader();
  if (!reader) throw new Error("missing stream body");
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const next = await readWithIdleTimeout(reader);
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  }
}

export async function classifyResponse(response, wire) {
  try {
    const type = response?.headers?.get("content-type") || "";
    if (!type.toLowerCase().includes("text/event-stream")) {
      const data = await response.clone().json();
      return classifyData(data, wire, jsonReplay(response, data));
    }
    const text = await bufferSse(response);
    return classifySse(text, wire, streamReplay(response, text));
  } catch {
    return { kind: "none", replay: response };
  }
}

function utf8Bytes(text) {
  return UTF8_ENCODER.encode(text).length;
}

export function renderVaultResult(results) {
  try {
    if (!Array.isArray(results) || results.length === 0) return "No matching content found in the vault for that query.";
    const chunks = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index] || {};
      const source = result.toolName ? ` from ${result.toolName}` : "";
      chunks.push(`[chunk ${index + 1}${source}]\n${typeof result.text === "string" ? result.text : ""}`);
    }
    const joined = chunks.join("\n\n");
    if (utf8Bytes(joined) <= SEARCH_RESULT_CAP_BYTES) return joined;
    const marker = "\n…[truncated]";
    return `${byteSafePrefix(joined, SEARCH_RESULT_CAP_BYTES - utf8Bytes(marker))}${marker}`;
  } catch {
    return "No matching content found in the vault for that query.";
  }
}

export function appendVaultTurn(body, wire, result, resultTexts) {
  const calls = Array.isArray(result?.calls) ? result.calls : [];
  if (!body || !Array.isArray(body.messages) || calls.length === 0 || !result.assistantRaw) {
    throw new Error("invalid vault turn");
  }
  const texts = Array.isArray(resultTexts) ? resultTexts : [];
  const messages = [...body.messages];
  if (wire === "openai") {
    // One assistant turn carrying all vault tool_calls, then a tool result per
    // call so no tool_call is left without a matching result (some providers
    // hard-error otherwise).
    messages.push(result.assistantRaw);
    for (let index = 0; index < calls.length; index += 1) {
      messages.push({ role: "tool", tool_call_id: calls[index].callId, content: texts[index] ?? "" });
    }
  } else if (wire === "claude") {
    // Claude pairs every tool_use with a tool_result block in a single user turn.
    const toolResults = calls.map((call, index) => ({
      type: "tool_result", tool_use_id: call.callId, content: texts[index] ?? "",
    }));
    messages.push(
      { role: "assistant", content: result.assistantRaw },
      { role: "user", content: toolResults },
    );
  } else {
    throw new Error("unsupported vault wire");
  }
  return { ...body, messages };
}

function errorContent(value) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value) || "";
  } catch {
    return "";
  }
}

function isToolError(result, content) {
  return result?.is_error === true || result?.status === "error" || VAULT_ERROR_RE.test(errorContent(content));
}

function openAiVaultCalls(message) {
  const calls = [];
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (let index = 0; index < toolCalls.length && calls.length < MAX_REPAIR_CALLS; index += 1) {
    const call = toolCalls[index];
    if (call?.function?.name === VAULT_TOOL_NAME && typeof call.id === "string") {
      calls.push({ id: call.id, args: parseArgs(call.function.arguments) });
    }
  }
  return calls;
}

function claudeVaultCalls(message) {
  const calls = [];
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (let index = 0; index < blocks.length && calls.length < MAX_REPAIR_CALLS; index += 1) {
    const block = blocks[index];
    if (block?.type === "tool_use" && block.name === VAULT_TOOL_NAME && typeof block.id === "string") {
      calls.push({ id: block.id, args: block.input || {} });
    }
  }
  return calls;
}

function findOpenAiResult(messages, start, id) {
  for (let index = start; index < messages.length && index < MAX_REPAIR_MESSAGES; index += 1) {
    const message = messages[index];
    if (message?.role === "tool" && message.tool_call_id === id) return { target: message, content: message.content };
  }
  return null;
}

function findClaudeResult(messages, start, id) {
  for (let index = start; index < messages.length && index < MAX_REPAIR_MESSAGES; index += 1) {
    const blocks = Array.isArray(messages[index]?.content) ? messages[index].content : [];
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (block?.type === "tool_result" && block.tool_use_id === id) return { target: block, content: block.content };
    }
  }
  return null;
}

export async function repairInboundVaultResults(body, { conversationId, limit = DEFAULT_SEARCH_LIMIT } = {}) {
  try {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || !conversationId) return 0;
    const replacements = [];
    for (let index = 0; index < messages.length && index < MAX_REPAIR_MESSAGES; index += 1) {
      const message = messages[index];
      const calls = [...openAiVaultCalls(message), ...claudeVaultCalls(message)];
      for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
        const call = calls[callIndex];
        const found = findOpenAiResult(messages, index + 1, call.id) || findClaudeResult(messages, index + 1, call.id);
        if (!found || !isToolError(found.target, found.content)) continue;
        const results = await searchVault({ conversationId, query: call.args?.query, vaultId: call.args?.vault_id, limit });
        replacements.push({ target: found.target, content: renderVaultResult(results) });
      }
    }
    for (let index = 0; index < replacements.length; index += 1) replacements[index].target.content = replacements[index].content;
    return replacements.length;
  } catch {
    return 0;
  }
}

export async function runVaultLoop({ dispatch, body, wire, conversationId, searchLimit = DEFAULT_SEARCH_LIMIT, log = null }) {
  let firstResponse = null;
  let firstFallback = null;
  let current = body;
  let vaultCalls = 0;
  try {
    for (let turn = 0; turn < MAX_VAULT_TURNS; turn += 1) {
      const response = await dispatch(current, { vaultInternal: turn > 0 });
      if (!firstResponse) firstResponse = response;
      const classified = await classifyResponse(response, wire);
      if (!firstFallback) firstFallback = classified.replay || firstResponse;
      if (classified.kind !== "call") {
        if (vaultCalls > 0) log?.info?.("VAULT", `served ${vaultCalls} vault search(es)`);
        return classified.replay || response;
      }
      // Execute EVERY vault call in the turn (models emit parallel calls), one
      // capped result each, in order. The 5-turn bound is on turns, not calls.
      const turnCalls = Array.isArray(classified.calls) ? classified.calls : [];
      const resultTexts = [];
      for (let index = 0; index < turnCalls.length; index += 1) {
        const results = await searchVault({ conversationId, query: turnCalls[index].query, vaultId: turnCalls[index].vaultId, limit: searchLimit });
        resultTexts.push(renderVaultResult(results));
        vaultCalls += 1;
        recordVaultHit();
      }
      current = appendVaultTurn(current, wire, classified, resultTexts);
    }
    // At the cap, make one final bounded dispatch and forward it as-is.
    return await dispatch(current, { vaultInternal: false });
  } catch {
    if (firstFallback) return firstFallback;
    if (firstResponse) return firstResponse;
    try { return await dispatch(body, { vaultInternal: false }); } catch { return new Response(null, { status: 502 }); }
  }
}
