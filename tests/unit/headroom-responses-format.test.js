// #1998 — Headroom compression treated a Codex (openai-responses) body.input
// array as OpenAI messages: it sent Responses items to /v1/compress and then
// assigned the returned OpenAI messages back to body.input, violating the
// Responses format contract. body.input must stay Responses-shaped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom openai-responses format (#1998)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps body.input in Responses format after compressing an openai-responses request", async () => {
    // Headroom always returns compressed OpenAI-style messages.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed text" }],
        tokens_before: 100,
        tokens_after: 90,
        tokens_saved: 10,
      }),
    }));

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a long original message ".repeat(20) }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    // body.input must remain Responses items (type:"message" + content array),
    // NOT the raw OpenAI messages ({ role, content: "<string>" }) the bug produced.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray(body.input[0].content)).toBe(true);
    expect(typeof body.input[0].content).not.toBe("string");
  });

  // #2132: tool/reasoning protocol items must never be collapsed into a
  // message and round-tripped. Since the native tool-output lane landed, the
  // eligible plain-text function_call_output strings ARE compressed in place;
  // everything else (function_call arguments, reasoning, structured outputs)
  // stays byte-identical and the input keeps the Responses shape.
  it("compresses only plain-text tool outputs in Responses tool/reasoning history instead of collapsing it into a message (#2132)", async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          messages: payload.messages.map((message) => ({ ...message, content: "compressed tool history" })),
          tokens_saved: 10,
        }),
      };
    });

    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "investigate bug" }],
      },
      {
        type: "function_call",
        call_id: "call_apply_patch_123",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "function_call_output",
        call_id: "call_apply_patch_123",
        output: "patch applied cleanly with a very long plain-text summary",
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need a plan" }],
      },
    ];
    const body = {
      input: structuredClone(input),
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
    };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledOnce();
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body).messages;
    expect(sent).toEqual([
      { role: "tool", tool_call_id: "headroom-tool-0", content: "patch applied cleanly with a very long plain-text summary" },
    ]);
    expect(body.input).toHaveLength(input.length);
    expect(body.input[0]).toEqual(input[0]);
    expect(body.input[1]).toEqual(input[1]); // function_call arguments untouched
    expect(body.input[2]).toEqual({ ...input[2], output: "compressed tool history" });
    expect(body.input[3]).toEqual(input[3]); // reasoning untouched
    expect(body.tools).toEqual([{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }]);
  });

  it("skips Responses tool history when no output is eligible plain text (#2132)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [], tokens_saved: 10 }),
    }));

    const input = [
      {
        type: "function_call",
        call_id: "call_apply_patch_123",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "function_call_output",
        call_id: "call_apply_patch_123",
        output: '{"status":"ok"}',
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need a plan" }],
      },
    ];
    const body = { input: structuredClone(input) };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(body.input).toEqual(input);
    expect(diagnostics.reason).toBe("no eligible plain-text tool output");
  });
});
