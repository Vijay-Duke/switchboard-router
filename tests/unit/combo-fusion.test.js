import { describe, it, expect, vi } from "vitest";

import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Minimal OpenAI-chat JSON Response used by the combo service tests.
function okResponse(content, { delayMs = 0 } = {}) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const res = new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(res), delayMs)) : res;
}

function errResponse(status = 500) {
  return new Response(JSON.stringify({ error: { message: "boom" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fusion combo", () => {
  it("answers directly with a single-model panel (nothing to fuse)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("solo"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/only"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/only");
  });

  it("fans out to the panel then routes a synthesis turn to the judge", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, panelOpts) => {
      const isPanel = panelOpts === true || panelOpts?.isPanel === true;
      seen.push(model);
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true, tools: [{ name: "x" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      childComboDepth: 2,
    });

    // 3 panel calls + 1 judge call.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
    expect(seen.slice(0, 3).sort()).toEqual(["p/a", "p/b", "p/c"]);
    expect(seen[3]).toBe("p/judge");

    // Panel calls are non-streaming with tools stripped; M3 passes { isPanel, signal }.
    for (const [body, model, panelOpts] of handleSingleModel.mock.calls.filter(([, m]) => m !== "p/judge")) {
      expect(body.stream).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(panelOpts === true || panelOpts?.isPanel === true).toBe(true);
      expect(panelOpts?.signal).toBeDefined();
      expect(panelOpts?.comboDepth).toBe(2);
    }

    // Judge call carries every panel answer + keeps the client's stream flag.
    const [judgeBody, , judgeOpts] = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeBody.messages.at(-1).content;
    expect(judgeText).toContain("ans-p/a");
    expect(judgeText).toContain("ans-p/b");
    expect(judgeText).toContain("ans-p/c");
    expect(judgeText).toContain("Source 1");
    expect(judgeBody.stream).toBe(true);
    expect(judgeOpts === true || judgeOpts?.isPanel === true).toBe(false);
    expect(judgeOpts?.comboDepth).toBe(2);

    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("defaults the judge to the first panel model when none is set", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => { seen.push(model); return okResponse(`ans-${model}`); });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
    });
    // Last call is the judge; defaults to panel[0].
    expect(seen.at(-1)).toBe("p/first");
  });

  it("proceeds on quorum without waiting for a straggler (grace window)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/slow") return okResponse("slow", { delayMs: 5000 });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`fast-${model}`);
    });

    const t0 = Date.now();
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/x", "p/y", "p/slow"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
    });
    const elapsed = Date.now() - t0;

    // Two fast answers reach quorum; grace is 50ms, so we never wait ~5s for p/slow.
    expect(elapsed).toBeLessThan(2000);

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("fast-p/x");
    expect(judgeText).toContain("fast-p/y");
    expect(judgeText).not.toContain("slow");
  });

  it("returns the lone survivor directly when only one panel model succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/ok") return okResponse("lone");
      return errResponse(500);
    });
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // No judge call — single answer means there is nothing to fuse.
    const judged = handleSingleModel.mock.calls.some(([, m]) => m === "p/judge");
    expect(judged).toBe(false);
    // M3: no re-dispatch of the survivor (only the original panel fan-out)
    const okCalls = handleSingleModel.mock.calls.filter(([, m]) => m === "p/ok");
    expect(okCalls.length).toBe(1);
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices?.[0]?.message?.content).toBe("lone");
  });

  it("preserves the survivor's client response format", async () => {
    const claude = new Response(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "bonjour" }],
    }), { headers: { "Content-Type": "application/json" } });
    const handleSingleModel = vi.fn(async (_body, model) => model === "p/claude" ? claude : errResponse(500));

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/claude", "p/bad"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 10, panelHardTimeoutMs: 1000 },
    });

    await expect(res.json()).resolves.toMatchObject({ type: "message", content: [{ text: "bonjour" }] });
  });

  it("wraps a lone survivor as client-format SSE when streaming was requested", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => model === "p/ok" ? okResponse("lone") : errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 10, panelHardTimeoutMs: 1000 },
    });

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"lone"');
    expect(text).toContain("data: [DONE]");
  });

  it("infers and preserves a Claude survivor's SSE event format", async () => {
    const claude = new Response(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "bonjour" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const handleSingleModel = vi.fn(async (_body, model) => model === "p/claude" ? claude : errResponse(500));

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["p/claude", "p/bad"],
      handleSingleModel,
      log,
      tuning: { stragglerGraceMs: 10, panelHardTimeoutMs: 1000 },
    });

    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain('"text":"bonjour"');
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("data: [DONE]");
  });

  it("passes the caller abort signal to fallback attempts and stops after abort", async () => {
    const caller = new AbortController();
    const handleSingleModel = vi.fn(async (_body, _model, opts) => {
      expect(opts.signal).toBe(caller.signal);
      caller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
      abortSignal: caller.signal,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(499);
  });

  it("passes the caller abort signal to the fusion judge", async () => {
    const caller = new AbortController();
    const handleSingleModel = vi.fn(async (_body, model, opts) => {
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      abortSignal: caller.signal,
    });

    const judgeCall = handleSingleModel.mock.calls.find(([, model]) => model === "p/judge");
    expect(judgeCall?.[2]?.signal).toBe(caller.signal);
  });

  it("aborts in-flight panel signals when the caller disconnects", async () => {
    const caller = new AbortController();
    const panelSignals = [];
    const handleSingleModel = vi.fn(async (_body, model, opts) => {
      if (model === "p/judge") return okResponse("FINAL");
      panelSignals.push(opts.signal);
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    });

    const fusion = handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      abortSignal: caller.signal,
      tuning: { panelHardTimeoutMs: 1000 },
    });
    await Promise.resolve();
    caller.abort();

    const res = await fusion;
    expect(res.status).toBe(499);
    expect(panelSignals).toHaveLength(2);
    expect(panelSignals.every((signal) => signal.aborted)).toBe(true);
    expect(handleSingleModel.mock.calls.some(([, model]) => model === "p/judge")).toBe(false);
  });

  it("returns 503 when the whole panel fails", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.status).toBe(503);
  });

  it("flattens previous tool history and assistant tool_calls into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "find files" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "find" } }] },
          { role: "tool", tool_call_id: "c1", content: "['a.js']" },
          { role: "user", content: "describe it" }
        ],
        tools: [{ type: "function" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    // Panel calls keep every turn but tool turns are flattened to assistant prose.
    const panelCalls = handleSingleModel.mock.calls.filter(([, m, o]) => m !== 'p/judge' && (o === true || o?.isPanel === true));
    expect(panelCalls.length).toBe(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.messages.length).toBe(4);
      expect(panelBody.messages[0]).toEqual({ role: "user", content: "find files" });
      expect(panelBody.messages[1].tool_calls).toBeUndefined();
      expect(panelBody.messages[1].content).toContain("find");
      expect(panelBody.messages[2].role).toBe("assistant");
      expect(panelBody.messages[2].content).toContain("['a.js']");
      expect(panelBody.messages[3]).toEqual({ role: "user", content: "describe it" });
    }

    // Judge call still receives the unmodified history + synthesis prompt.
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeDefined();
    const judgeBody = judgeCall[0];
    expect(judgeBody.messages.length).toBe(5); // original 4 + judge prompt turn
    expect(judgeBody.messages[1].tool_calls).toBeDefined();
    expect(judgeBody.messages[2].role).toBe("tool");
  });

  it("flattens Anthropic-style tool_use and tool_result blocks in arrays", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "run" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }
        ],
        tools: [{ name: "run", description: "d" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([, m, o]) => m !== 'p/judge' && (o === true || o?.isPanel === true));
    expect(panelCalls.length).toBe(2);
    const panelBody = panelCalls[0][0];
    
    expect(panelBody.tools).toBeUndefined();
    expect(panelBody.messages.length).toBe(3);
    
    // Flattened tool_use
    expect(panelBody.messages[1].content).toBe("ok\n[Called tools: run]");
    
    // Flattened tool_result
    expect(panelBody.messages[2].content).toBe("[Tool result: done]");
  });

  it("wraps single survivor as SSE when client requested streaming", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/ok") return okResponse("stream-me");
      return errResponse(500);
    });
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // Should return SSE since client asked stream:true
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("stream-me");
    expect(text).toContain("[DONE]");
  });

  it("falls back to best panel answer when judge fails", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return errResponse(500);
      if (model === "p/a") return okResponse("answer a lorem ipsum dolor sit");
      return okResponse("answer b short");
    });
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // Judge failed → falls back to longest panel answer (p/a)
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices?.[0]?.message?.content).toBe("answer a lorem ipsum dolor sit");
    expect(handleSingleModel.mock.calls.filter(([, m]) => m === "p/judge").length).toBe(1);
    // Only 2 panel calls + 1 judge call = 3 total
    expect(handleSingleModel.mock.calls.length).toBe(3);
  });

  it("wraps best panel answer as SSE when judge fails and client streamed", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return errResponse(503);
      if (model === "p/a") return okResponse("panel answer a");
      return okResponse("panel answer b");
    });
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("panel answer");
    expect(text).toContain("[DONE]");
  });
});

describe("combo 404 fallback", () => {
  it("404 on candidate A advances to candidate B and returns B's success", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404, headers: { "Content-Type": "application/json" } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "B response" } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
      );

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/model-a", "p/model-b"],
      handleSingleModel,
      log,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("B response");
  });

  it("preserves account-level non-fallback errors (400) without advancing to next model", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "Content-Type": "application/json" } })
      );

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/model-a", "p/model-b"],
      handleSingleModel,
      log,
    });

    // 400 from candidate A should NOT advance to B
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
  });
});
