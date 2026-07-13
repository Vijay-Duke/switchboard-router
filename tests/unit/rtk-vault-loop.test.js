import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultConversationId } from "open-sse/routing/feedbackAsk.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let dbApi;
let driver;
let vault;
let runtimeDeps;
let loop;
let searchSpy;

function jsonResponse(data) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function openAiCall(id = "call_1", content = "") {
  return jsonResponse({
    choices: [{ message: {
      role: "assistant",
      content,
      tool_calls: [{ id, type: "function", function: { name: "sb_vault_search", arguments: '{"query":"x","vault_id":"vlt_1"}' } }],
    } }],
  });
}

function openAiTwoCalls() {
  return jsonResponse({ choices: [{ message: {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "sb_vault_search", arguments: '{"query":"first","vault_id":"vlt_1"}' } },
      { id: "call_2", type: "function", function: { name: "sb_vault_search", arguments: '{"query":"second","vault_id":"vlt_2"}' } },
    ],
  } }] });
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < chunks.length; index += 1) controller.enqueue(encoder.encode(chunks[index]));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-rtk-vault-loop-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  dbApi = await import("@/lib/db/index.js");
  driver = await import("@/lib/db/driver.js");
  vault = await import("@/lib/db/repos/vaultRepo.js");
  runtimeDeps = await import("open-sse/runtimeDeps.js");
  loop = await import("open-sse/rtk/vaultLoop.js");
  await dbApi.initDb();
});

beforeEach(async () => {
  const db = await driver.getAdapter();
  db.run("DELETE FROM vault_chunks");
  db.run("DELETE FROM vault_entries");
  try { db.run("DELETE FROM vault_fts"); } catch {}
  searchSpy = vi.fn(async () => [{ entryId: "vlt_1", chunkIndex: 0, text: "vault answer", toolName: "read" }]);
  runtimeDeps.setOpenSseDeps({ searchVault: searchSpy });
});

afterAll(async () => {
  try { await driver?.closeAdapter?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("RTK vault loop", () => {
  it("injects source-wire tools idempotently only when tools already exist", () => {
    const openai = { tools: [] };
    const claude = { tools: [] };
    expect(loop.injectVaultTool(openai, "openai")).toBe(true);
    expect(openai.tools[0]).toMatchObject({ type: "function", function: { name: "sb_vault_search" } });
    expect(loop.injectVaultTool(claude, "claude")).toBe(true);
    expect(claude.tools[0]).toMatchObject({ name: "sb_vault_search", input_schema: expect.any(Object) });
    expect(loop.injectVaultTool(openai, "openai")).toBe(false);
    expect(openai.tools).toHaveLength(1);
    expect(loop.injectVaultTool({}, "openai")).toBe(false);
  });

  it("classifies OpenAI JSON none, pure calls, and mixed calls", async () => {
    const plain = jsonResponse({ choices: [{ message: { role: "assistant", content: "hello" } }] });
    const none = await loop.classifyResponse(plain, "openai");
    expect(none.kind).toBe("none");
    await expect(none.replay.json()).resolves.toEqual({ choices: [{ message: { role: "assistant", content: "hello" } }] });

    const pure = await loop.classifyResponse(openAiCall(), "openai");
    expect(pure).toMatchObject({ kind: "call", callId: "call_1", query: "x", vaultId: "vlt_1" });
    const mixed = await loop.classifyResponse(openAiCall("call_2", "here you go"), "openai");
    expect(mixed.kind).toBe("mixed");
  });

  it("classifies Claude JSON pure and mixed calls", async () => {
    const pure = await loop.classifyResponse(jsonResponse({ content: [{ type: "tool_use", id: "tool_1", name: "sb_vault_search", input: { query: "x", vault_id: "vlt_1" } }] }), "claude");
    expect(pure).toMatchObject({ kind: "call", callId: "tool_1", query: "x", vaultId: "vlt_1" });
    const mixed = await loop.classifyResponse(jsonResponse({ content: [
      { type: "text", text: "here you go" },
      { type: "tool_use", id: "tool_2", name: "sb_vault_search", input: { query: "x" } },
    ] }), "claude");
    expect(mixed.kind).toBe("mixed");
  });

  it("caps rendered results on a UTF-8 boundary", () => {
    const rendered = loop.renderVaultResult([{ text: `${"x".repeat(7_000)}😀`, toolName: "read" }]);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(6 * 1024);
    expect(LONE_SURROGATE.test(rendered)).toBe(false);
  });

  it("runs pure calls internally and appends the OpenAI tool result", async () => {
    const calls = [];
    const response = await loop.runVaultLoop({
      body: { messages: [{ role: "user", content: "find it" }], tools: [] },
      wire: "openai",
      conversationId: "conversation-a",
      dispatch: async (body, options) => {
        calls.push({ body, options });
        return calls.length === 1 ? openAiCall() : jsonResponse({ choices: [{ message: { role: "assistant", content: "found it" } }] });
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].options.vaultInternal).toBe(true);
    expect(calls[1].body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1", content: expect.stringContaining("vault answer") });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({ choices: [{ message: { content: "found it" } }] });
  });

  it("serves every call in a parallel pure-vault turn with matched ids and order", async () => {
    const calls = [];
    const response = await loop.runVaultLoop({
      body: { messages: [{ role: "user", content: "find it" }], tools: [] },
      wire: "openai",
      conversationId: "conversation-a",
      dispatch: async (body) => {
        calls.push({ body });
        return calls.length === 1 ? openAiTwoCalls() : jsonResponse({ choices: [{ message: { role: "assistant", content: "done" } }] });
      },
    });
    expect(calls).toHaveLength(2);
    expect(searchSpy).toHaveBeenCalledTimes(2); // one search per vault call
    const msgs = calls[1].body.messages;
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["call_1", "call_2"]); // matched + ordered
    expect(toolMsgs.every((m) => typeof m.content === "string" && m.content.includes("vault answer"))).toBe(true);
    const assistant = msgs.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(assistant.tool_calls.map((c) => c.id)).toEqual(["call_1", "call_2"]); // assistant carries both calls
    await expect(response.json()).resolves.toMatchObject({ choices: [{ message: { content: "done" } }] });
  });

  it("bounds repeated vault calls and still returns a valid response", async () => {
    let calls = 0;
    const response = await loop.runVaultLoop({
      body: { messages: [{ role: "user", content: "find it" }], tools: [] },
      wire: "openai",
      conversationId: "conversation-a",
      dispatch: async () => {
        calls += 1;
        return openAiCall(`call_${calls}`);
      },
    });
    expect(calls).toBeLessThanOrEqual(loop.MAX_VAULT_TURNS + 1);
    expect(response).toBeInstanceOf(Response);
  });

  it("fails open to the first response if a later dispatch throws", async () => {
    let calls = 0;
    const response = await loop.runVaultLoop({
      body: { messages: [{ role: "user", content: "find it" }], tools: [] },
      wire: "openai",
      conversationId: "conversation-a",
      dispatch: async () => {
        calls += 1;
        if (calls === 1) return openAiCall();
        throw new Error("upstream failed");
      },
    });
    expect(response).toBeInstanceOf(Response);
    await expect(response.json()).resolves.toMatchObject({ choices: expect.any(Array) });
  });

  it("repairs only errored inbound vault results from real vault storage", async () => {
    await vault.putVaultEntry({
      id: "vlt_1",
      conversationId: "conversation-a",
      toolName: "read",
      content: "the secret matching content is here",
      chunks: ["the secret matching content is here"],
      ttlMs: 60_000,
    });
    runtimeDeps.setOpenSseDeps({ searchVault: vault.searchVault });
    const body = { messages: [
      { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "sb_vault_search", arguments: '{"query":"matching","vault_id":"vlt_1"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "Error: unknown tool sb_vault_search" },
      { role: "assistant", tool_calls: [{ id: "call_2", function: { name: "sb_vault_search", arguments: '{"query":"matching","vault_id":"vlt_1"}' } }] },
      { role: "tool", tool_call_id: "call_2", content: "already fetched" },
    ] };
    await expect(loop.repairInboundVaultResults(body, { conversationId: "conversation-a" })).resolves.toBe(1);
    expect(body.messages[1].content).toContain("matching content");
    expect(body.messages[3].content).toBe("already fetched");
  });

  it("classifies streamed OpenAI calls and replays unchanged plain SSE", async () => {
    const callResponse = sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"sb_vault_search","arguments":"{\\\"query\\\":\\\"x"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\",\\\"vault_id\\\":\\\"vlt_1\\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const call = await loop.classifyResponse(callResponse, "openai");
    expect(call).toMatchObject({ kind: "call", query: "x", vaultId: "vlt_1" });

    const raw = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
    const plain = await loop.classifyResponse(sseResponse([raw]), "openai");
    expect(plain.kind).toBe("none");
    await expect(plain.replay.text()).resolves.toBe(raw);
  });

  it("scopes the vault per conversation, not per opening user message", () => {
    const apiHash = "keyhash";
    const convA = [
      { role: "user", content: "help me" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_a", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_a", content: "A big result" },
    ];
    const convB = [
      { role: "user", content: "help me" }, // identical opening message
      { role: "assistant", content: "", tool_calls: [{ id: "call_b", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_b", content: "B big result" },
    ];
    const idA = vaultConversationId(convA, apiHash);
    const idB = vaultConversationId(convB, apiHash);
    expect(idA).toBeTruthy();
    expect(idA).not.toBe(idB); // isolated despite same first user message

    // Stable as the conversation grows at the tail (real turns AND internal loop
    // turns are appended after the prefix, so the scope id must not shift).
    const grown = [...convA, { role: "assistant", content: "done" }, { role: "user", content: "next" }];
    expect(vaultConversationId(grown, apiHash)).toBe(idA);
  });

  it("forwards a turn that mixes the vault call with another tool call", async () => {
    const mixedOpenAi = jsonResponse({ choices: [{ message: {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_v", type: "function", function: { name: "sb_vault_search", arguments: '{"query":"x"}' } },
        { id: "call_o", type: "function", function: { name: "run_tests", arguments: "{}" } },
      ],
    } }] });
    expect((await loop.classifyResponse(mixedOpenAi, "openai")).kind).toBe("mixed");

    const mixedClaude = jsonResponse({ content: [
      { type: "tool_use", id: "t_v", name: "sb_vault_search", input: { query: "x" } },
      { type: "tool_use", id: "t_o", name: "run_tests", input: {} },
    ] });
    expect((await loop.classifyResponse(mixedClaude, "claude")).kind).toBe("mixed");
  });

  it("forwards a multi-choice (n>1) response instead of intercepting choice 0", async () => {
    const multiJson = jsonResponse({ choices: [
      { index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "call_v", type: "function", function: { name: "sb_vault_search", arguments: '{"query":"x"}' } }] } },
      { index: 1, message: { role: "assistant", content: "alternative answer" } },
    ] });
    expect((await loop.classifyResponse(multiJson, "openai")).kind).toBe("none");

    const multiSse = sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_v","function":{"name":"sb_vault_search","arguments":"{\\\"query\\\":\\\"x\\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":1,"delta":{"content":"other candidate"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    // Forwarded (not intercepted) — a second choice at index 1 exists.
    expect((await loop.classifyResponse(multiSse, "openai")).kind).not.toBe("call");
  });

  it("forwards a streamed turn with a nameless sibling tool call", async () => {
    const sse = sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_v","function":{"name":"sb_vault_search","arguments":"{\\\"query\\\":\\\"x\\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_n","function":{"arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    // The second call streams an id + args but no name — it must still block interception.
    expect((await loop.classifyResponse(sse, "openai")).kind).toBe("mixed");
  });

  it("classifies streamed Claude tool_use calls and replays unchanged plain SSE", async () => {
    const callResponse = sseResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"sb_vault_search"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\","}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"vault_id\\":\\"vlt_1\\"}"}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const call = await loop.classifyResponse(callResponse, "claude");
    expect(call).toMatchObject({ kind: "call", callId: "tool_1", query: "x", vaultId: "vlt_1" });

    const raw = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\ndata: [DONE]\n\n';
    const plain = await loop.classifyResponse(sseResponse([raw]), "claude");
    expect(plain.kind).toBe("none");
    await expect(plain.replay.text()).resolves.toBe(raw);
  });
});
