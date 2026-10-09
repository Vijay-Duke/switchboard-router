import { VAULT_TOOL_NAME, SEARCH_RESULT_CAP_BYTES } from "./vault.js";
import { recordVaultHit } from "./vaultStats.js";
import { searchVault } from "../runtimeDeps.js";
import { byteSafePrefix } from "../utils/truncate.js";

export const MAX_VAULT_TURNS = 5;
export const DEFAULT_SEARCH_LIMIT = 5;
// Match the native first-progress ceiling; its tighter model-progress watchdog
// still owns stalled thinking/text. Vault classification must allow healthy
// long reasoning in tool-enabled conversations before retrieval is known.
export const STREAM_BUFFER_IDLE_MS = 120_000;
export const MAX_VAULT_LOOP_MS = 600_000;
export const MAX_VAULT_INTERNAL_MS = 120_000;
export const MAX_VAULT_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_VAULT_SEARCHES = 100;
export const VAULT_SEARCH_TIMEOUT_MS = 5_000;

const UTF8_ENCODER = new TextEncoder();
const VAULT_ERROR_RE = /^\s*(?:<tool_use_error>\s*)?(?:Error:\s*)?(?:unknown tool|no (?:such )?tool (?:named|available)|tool not found|not a (?:valid|recognized) tool)[^\n]{0,80}sb_vault_search/i;
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

function streamReplay(response, text) {
  if ([204, 205, 304].includes(response.status)) return new Response(null, { status: response.status, statusText: response.statusText, headers: cleanHeaders(response.headers, true) });
  // Vault tool conversations opt into full buffering so classification remains
  // simple and correct; normal streaming requests never take this path.
  const bytes = typeof text === "string" ? UTF8_ENCODER.encode(text) : text;
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toVaultCall(callId, args) {
  if (typeof callId !== "string" || !callId || typeof args?.query !== "string"
    || (args.vault_id != null && typeof args.vault_id !== "string")) return null;
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
  if (calls.some((call) => !call) || new Set(calls.map(call => call.callId)).size !== calls.length) return null;
  const first = calls[0];
  return { kind: "call", callId: first.callId, query: first.query, vaultId: first.vaultId, calls, assistantRaw };
}

function classifyOpenAiJson(data, replay) {
  // With n>1 choices, intercepting choice 0 would silently discard the rest.
  if (Array.isArray(data?.choices) && data.choices.length > 1) return { kind: "none", replay };
  const choice = data?.choices?.[0];
  const message = choice?.message;
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
  if (hasOtherCall || data?.error
    || (choice?.finish_reason != null && !["stop", "tool_calls", "function_call"].includes(choice.finish_reason))
    || (message && Object.keys(message).some(key => {
      if (["role", "content", "tool_calls"].includes(key)) return false;
      if (key === "refusal" && message[key] == null) return false;
      if (key === "annotations" && Array.isArray(message[key]) && message[key].length === 0) return false;
      return true;
    }))) return { kind: "mixed", replay };
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
    } else if (block?.type !== "text" && block?.type !== "thinking" && block?.type !== "redacted_thinking") {
      // Provider-managed tools and unfamiliar blocks must reach the client intact.
      hasOtherCall = true;
    }
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) hasText = true;
  }
  if (vaultCalls.length === 0) return { kind: "none", replay };
  if (hasOtherCall || hasText || data?.error || (data?.stop_reason != null && data.stop_reason !== "tool_use")) return { kind: "mixed", replay };
  return buildCallResult(vaultCalls, blocks.filter(block => block?.type !== "text")) || { kind: "none", replay };
}

function sseData(text) {
  const values = [];
  values.hasDone = false;
  values.invalid = false;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n").trim();
    if (!data) continue;
    if (data === "[DONE]") { values.hasDone = true; continue; }
    try { values.push(JSON.parse(data)); } catch { values.invalid = true; }
  }
  return values;
}

function classifyOpenAiSse(text, replay) {
  const calls = new Map();
  let hasText = false;
  let multiChoice = false;
  const events = sseData(text);
  let unsafe = events.invalid;
  let terminal = events.hasDone;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    if (events[eventIndex]?.error) unsafe = true;
    const choices = Array.isArray(events[eventIndex]?.choices) ? events[eventIndex].choices : [];
    // n>1 streaming: a chunk carrying multiple choices, or any choice past
    // index 0, means other candidates exist that interception would drop.
    if (choices.length > 1) multiChoice = true;
    const choice = choices[0];
    if (Number.isInteger(choice?.index) && choice.index > 0) multiChoice = true;
    if (choice?.finish_reason != null) {
      terminal = true;
      if (!["stop", "tool_calls", "function_call"].includes(choice.finish_reason)) unsafe = true;
    }
    const delta = choice?.delta;
    if (!delta) continue;
    if (Object.keys(delta).some(key => !["role", "content", "tool_calls"].includes(key))) unsafe = true;
    if (typeof delta.content === "string" && delta.content.trim()) hasText = true;
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
      const part = toolCalls[callIndex];
      let index = part?.index;
      if (!Number.isInteger(index)) {
        if (!part?.id) { unsafe = true; continue; }
        index = [...calls.entries()].find(([, value]) => value.id === part.id)?.[0];
        if (index === undefined) {
          if (calls.size >= MAX_VAULT_SEARCHES) { unsafe = true; continue; }
          index = calls.size ? Math.max(...calls.keys()) + 1 : 0;
        }
      }
      if (!calls.has(index) && calls.size >= MAX_VAULT_SEARCHES) { unsafe = true; continue; }
      const previous = calls.get(index);
      if (previous?.id && part?.id && previous.id !== part.id) unsafe = true;
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
  if (unsafe || !terminal || multiChoice || hasOtherCall || hasText) return { kind: "mixed", replay };
  const assistantRaw = { role: "assistant", content: null, tool_calls: rawToolCalls };
  return buildCallResult(vaultCalls, assistantRaw) || { kind: "none", replay };
}

function classifyClaudeSse(text, replay) {
  const blocks = new Map();
  let hasText = false;
  const parsedEvents = sseData(text);
  let unsafe = parsedEvents.invalid;
  let terminal = parsedEvents.hasDone;
  for (const event of parsedEvents) {
    if (event?.type === "message_stop") terminal = true;
    if (event?.type === "message_delta" && event.delta?.stop_reason && event.delta.stop_reason !== "tool_use") unsafe = true;
    if (event?.type === "error") unsafe = true;
    const index = Number.isInteger(event?.index) ? event.index : 0;
    const block = event?.content_block;
    if (event?.type === "content_block_start" && block) {
      if (blocks.size >= MAX_VAULT_SEARCHES + 20) { unsafe = true; continue; }
      if (!["tool_use", "thinking", "redacted_thinking", "text"].includes(block.type)) unsafe = true;
      blocks.set(index, { ...block, partialInput: "" });
      if (block.type === "text" && block.text?.trim()) hasText = true;
    }
    const current = blocks.get(index);
    const delta = event?.type === "content_block_delta" ? event.delta : undefined;
    if (delta?.type === "text_delta" && delta.text?.trim()) hasText = true;
    if (!current) {
      if (event?.type === "content_block_delta") unsafe = true;
      continue;
    }
    if (delta?.type === "input_json_delta" && current.type === "tool_use") current.partialInput += delta.partial_json || "";
    else if (delta?.type === "thinking_delta" && current.type === "thinking") current.thinking = (current.thinking || "") + (delta.thinking || "");
    else if (delta?.type === "signature_delta" && current.type === "thinking") current.signature = (current.signature || "") + (delta.signature || "");
    else if (delta && delta.type !== "text_delta") unsafe = true;
  }
  const vaultCalls = [];
  const rawBlocks = [];
  for (const [, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    const { partialInput, ...raw } = block;
    if (block.type === "text") continue;
    if (block.type === "tool_use") {
      if (block.name !== VAULT_TOOL_NAME) unsafe = true;
      else {
        // Preserve initial input when a stream sends no JSON deltas.
        const input = partialInput ? parseArgs(partialInput) : block.input || {};
        vaultCalls.push(toVaultCall(block.id, input));
        raw.input = input;
      }
    }
    rawBlocks.push(raw);
  }
  if (vaultCalls.length === 0) return { kind: "none", replay };
  if (unsafe || !terminal || hasText) return { kind: "mixed", replay };
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

async function readWithIdleTimeout(reader, signal, timeoutMs) {
  let timer, onAbort;
  try {
    if (signal?.aborted) throw new Error("vault operation aborted");
    const timed = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("vault stream idle or deadline exceeded")), timeoutMs);
      onAbort = () => reject(new Error("vault operation aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([reader.read(), timed]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function bufferBody(response, { signal } = {}) {
  // Consume once. A cancelled clone waits for its unread tee sibling forever.
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: new Uint8Array() };
  const chunks = [];
  let size = 0;
  const deadline = Date.now() + MAX_VAULT_LOOP_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("vault buffer deadline exceeded");
      const next = await readWithIdleTimeout(reader, signal, Math.min(STREAM_BUFFER_IDLE_MS, remaining));
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_VAULT_BUFFER_BYTES) throw new Error("vault buffer size exceeded");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes };
  } catch (error) {
    try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export async function classifyResponse(response, wire, { signal } = {}) {
  if (!response.ok) return { kind: "none", replay: response };
  const type = response?.headers?.get("content-type") || "";
  let buffered;
  try {
    buffered = await bufferBody(response, { signal });
    const replay = streamReplay(response, buffered.bytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffered.bytes);
    if (!type.toLowerCase().includes("text/event-stream")) {
      const data = JSON.parse(text);
      return { ...classifyData(data, wire, replay), replay };
    }
    // Every classification, including pure calls, retains its readable fallback.
    return { ...classifySse(text, wire, replay), replay };
  } catch {
    if (buffered) return { kind: "none", replay: streamReplay(response, buffered.bytes) };
    const error = { type: "api_error", message: "Vault upstream stream did not complete." };
    return { kind: "none", replay: Response.json(wire === "claude" ? { type: "error", error } : { error }, { status: signal?.aborted ? 499 : 502 }) };
  }
}

async function boundedSearch(args, { signal, timeoutMs = VAULT_SEARCH_TIMEOUT_MS } = {}) {
  let timer, onAbort;
  try {
    if (signal?.aborted) throw new Error("vault operation aborted");
    const timed = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("vault search deadline exceeded")), timeoutMs);
      onAbort = () => reject(new Error("vault operation aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([searchVault(args), timed]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
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
  if (result?.is_error === false || result?.status === "success") return false;
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

export async function repairInboundVaultResults(body, { conversationId, limit = DEFAULT_SEARCH_LIMIT, signal } = {}) {
  try {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || !conversationId) return 0;
    const replacements = [];
    let searches = 0;
    const deadline = Date.now() + VAULT_SEARCH_TIMEOUT_MS;
    for (let index = 0; index < messages.length && index < MAX_REPAIR_MESSAGES; index += 1) {
      if (signal?.aborted || searches >= MAX_REPAIR_CALLS || Date.now() >= deadline) break;
      const message = messages[index];
      const calls = [...openAiVaultCalls(message), ...claudeVaultCalls(message)];
      for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
        const call = calls[callIndex];
        if (signal?.aborted || searches >= MAX_REPAIR_CALLS || Date.now() >= deadline) break;
        if (!toVaultCall(call.id, call.args)) continue;
        const found = findOpenAiResult(messages, index + 1, call.id) || findClaudeResult(messages, index + 1, call.id);
        if (!found || !isToolError(found.target, found.content)) continue;
        searches++;
        const results = await boundedSearch({ conversationId, query: call.args.query, vaultId: call.args.vault_id, limit }, { signal, timeoutMs: Math.max(1, deadline - Date.now()) });
        replacements.push({ target: found.target, content: renderVaultResult(results) });
      }
    }
    for (const replacement of replacements) {
      replacement.target.content = replacement.content;
      delete replacement.target.is_error;
      delete replacement.target.status;
    }
    return replacements.length;
  } catch {
    return 0;
  }
}

export async function runVaultLoop({ dispatch, body, wire, conversationId, searchLimit = DEFAULT_SEARCH_LIMIT, log = null, signal }) {
  let current = body;
  let vaultCalls = 0;
  const deadlineController = new AbortController();
  let timer = setTimeout(() => deadlineController.abort(), MAX_VAULT_LOOP_MS);
  const requestDeadline = Date.now() + MAX_VAULT_LOOP_MS;
  let retrievalStarted = false;
  const loopSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
  const dispatchBounded = async (value, options) => {
    let onAbort;
    const pending = Promise.resolve().then(() => {
      if (loopSignal.aborted) throw new Error("vault operation aborted");
      return dispatch(value, { ...options, signal: loopSignal });
    });
    // A late result from a provider ignoring cancellation must not hold a body.
    pending.then(response => {
      if (loopSignal.aborted) {
        try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
      }
    }, () => {});
    try {
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(new Error("vault operation aborted"));
        if (loopSignal.aborted) onAbort();
        else loopSignal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([pending, cancelled]);
    } finally { if (onAbort) loopSignal.removeEventListener("abort", onAbort); }
  };
  const failure = (message, status = 502) => {
    const error = { type: "api_error", message };
    return Response.json(wire === "claude" ? { type: "error", error } : { error }, { status });
  };
  const aborted = () => failure(signal?.aborted ? "Request aborted" : "Vault processing deadline exceeded.", signal?.aborted ? 499 : 502);
  try {
    for (let turn = 0; turn < MAX_VAULT_TURNS; turn += 1) {
      if (loopSignal.aborted) return aborted();
      const response = await dispatchBounded(current, { vaultInternal: turn > 0, signal: loopSignal });
      const classified = await classifyResponse(response, wire, { signal: loopSignal });
      if (loopSignal.aborted) return aborted();
      if (classified.kind !== "call") {
        if (vaultCalls > 0) log?.info?.("VAULT", `served ${vaultCalls} vault search(es)`);
        return classified.replay || response;
      }
      if (!retrievalStarted) {
        retrievalStarted = true;
        clearTimeout(timer);
        timer = setTimeout(() => deadlineController.abort(), Math.max(1, Math.min(MAX_VAULT_INTERNAL_MS, requestDeadline - Date.now())));
      }
      // Execute EVERY vault call in the turn (models emit parallel calls), one
      // capped result each, in order. The 5-turn bound is on turns, not calls.
      const turnCalls = Array.isArray(classified.calls) ? classified.calls : [];
      const resultTexts = [];
      for (let index = 0; index < turnCalls.length; index += 1) {
        if (loopSignal.aborted) return aborted();
        if (vaultCalls >= MAX_VAULT_SEARCHES) return failure("Vault search budget exceeded.");
        const results = await boundedSearch({ conversationId, query: turnCalls[index].query, vaultId: turnCalls[index].vaultId, limit: searchLimit }, { signal: loopSignal });
        resultTexts.push(renderVaultResult(results));
        vaultCalls += 1;
        recordVaultHit();
      }
      current = appendVaultTurn(current, wire, classified, resultTexts);
    }
    // At the cap, make one final bounded dispatch and forward it as-is.
    if (loopSignal.aborted) return aborted();
    return await dispatchBounded(current, { vaultInternal: false, signal: loopSignal });
  } catch {
    if (loopSignal.aborted) return aborted();
    return failure("Vault processing failed.");
  } finally { clearTimeout(timer); }
}
