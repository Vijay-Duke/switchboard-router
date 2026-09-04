/** Round-2 request-translator findings X55–X67, X68 (ollama / commandcode / vertex). */
import { describe, it, expect } from "vitest";
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";
import { openaiToVertexRequest } from "../../open-sse/translator/request/openai-to-vertex.js";
import { DEFAULT_THINKING_VERTEX_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";

const IMG = "data:image/png;base64,AAA";

describe("X55 image-only user message", () => {
  const imgMsg = { role: "user", content: [{ type: "image_url", image_url: { url: IMG } }] };
  it("image-only turn survives with images", () => {
    const out = openaiToOllamaRequest("m", { messages: [imgMsg] }, true);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].images).toEqual(["AAA"]);
  });
  it("text + image keeps both", () => {
    const out = openaiToOllamaRequest("m", {
      messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: IMG } }] }],
    }, true);
    expect(out.messages[0].content).toBe("see");
    expect(out.messages[0].images).toEqual(["AAA"]);
  });
  it("text-only still works", () => {
    const out = openaiToOllamaRequest("m", { messages: [{ role: "user", content: "hi" }] }, true);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("X56 ollama format", () => {
  const base = { messages: [{ role: "user", content: "hi" }] };
  it("json_object → format json", () => {
    expect(openaiToOllamaRequest("m", { ...base, response_format: { type: "json_object" } }, true).format)
      .toBe("json");
  });
  it("json_schema → format schema", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(openaiToOllamaRequest("m", {
      ...base, response_format: { type: "json_schema", json_schema: { name: "r", schema } },
    }, true).format).toEqual(schema);
  });
});

describe("X57 ollama max spellings", () => {
  it.each([
    [{ max_tokens: 100 }, 100],
    [{ max_completion_tokens: 500 }, 500],
  ])("%j → num_predict %i", (extra, expected) => {
    const out = openaiToOllamaRequest("m", { messages: [{ role: "user", content: "hi" }], ...extra }, true);
    expect(out.options.num_predict).toBe(expected);
  });
});

describe("X58 developer → system", () => {
  it("developer normalises to system", () => {
    const out = openaiToOllamaRequest("m", { messages: [{ role: "developer", content: "sys" }] }, true);
    expect(out.messages).toEqual([{ role: "system", content: "sys" }]);
  });
});

describe("X59 ollama stop / top_k", () => {
  it("stop and top_k land in options", () => {
    const out = openaiToOllamaRequest("m", {
      messages: [{ role: "user", content: "hi" }], stop: ["END"], top_k: 40,
    }, true);
    expect(out.options.stop).toEqual(["END"]);
    expect(out.options.top_k).toBe(40);
  });
});

describe("X60 tool images", () => {
  it("tool result with image keeps images", () => {
    const out = openaiToOllamaRequest("m", {
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        {
          role: "tool", tool_call_id: "c1",
          content: [{ type: "text", text: "shot" }, { type: "image_url", image_url: { url: IMG } }],
        },
      ],
    }, true);
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool.images).toEqual(["AAA"]);
  });
});

describe("X68 parallel_tool_calls false never trims ollama history", () => {
  it("both calls survive", () => {
    const out = openaiToOllamaRequest("m", {
      messages: [{
        role: "assistant", content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      }],
      parallel_tool_calls: false,
    }, true);
    expect(out.messages[0].tool_calls).toHaveLength(2);
  });
});

describe("X61 commandcode toolName resolution", () => {
  const pair = (toolMsg) => ({
    messages: [
      {
        role: "assistant", content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
      },
      toolMsg,
    ],
  });
  it("named pair resolves", () => {
    const out = openaiToCommandCodeRequest("m", pair({ role: "tool", tool_call_id: "c1", content: "sunny" }), true);
    const tr = out.params.messages.find((m) => m.role === "tool");
    expect(tr.content[0].toolCallId).toBe("c1");
    expect(tr.content[0].toolName).toBe("get_weather");
  });
  it("unnamed pair falls back to msg.name then ''", () => {
    const out = openaiToCommandCodeRequest("m", {
      messages: [{ role: "tool", tool_call_id: "zx", name: "fallback_fn", content: "x" }],
    }, true);
    const tr = out.params.messages.find((m) => m.role === "tool");
    expect(tr.content[0].toolName).toBe("fallback_fn");
  });
});

describe("X62 commandcode developer → system", () => {
  it("developer content joins params.system", () => {
    const out = openaiToCommandCodeRequest("m", {
      messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "hi" }],
    }, true);
    expect(out.params.system).toContain("be brief");
    expect(out.params.messages.every((m) => m.role !== "developer")).toBe(true);
  });
});

describe("X63 commandcode max spellings", () => {
  it.each([
    [{ max_tokens: 1 }, 1],
    [{ max_completion_tokens: 999 }, 999],
    [{ max_output_tokens: 3 }, 3],
  ])("%j → %i", (extra, expected) => {
    const out = openaiToCommandCodeRequest("m", { messages: [{ role: "user", content: "hi" }], ...extra }, true);
    expect(out.params.max_tokens).toBe(expected);
  });
});

describe("X64 commandcode stop / JSON instruction", () => {
  it("stop survives; JSON mode becomes an instruction", () => {
    const out = openaiToCommandCodeRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      stop: ["END"],
      response_format: { type: "json_object" },
    }, true);
    expect(out.params.stop).toEqual(["END"]);
    expect(out.params.system).toContain("valid JSON");
  });
});

describe("X65 stable threadId", () => {
  const body = () => ({ messages: [{ role: "user", content: "hi" }] });
  it("consecutive calls share threadId per connection", () => {
    const a = openaiToCommandCodeRequest("m", body(), true, { connectionId: "conn-r2d" });
    const b = openaiToCommandCodeRequest("m", body(), true, { connectionId: "conn-r2d" });
    expect(a.threadId).toBe(b.threadId);
  });
});

describe("X66 vertex signature, no credentials leak", () => {
  it("thoughtSignatures equal the Vertex constant", () => {
    const out = openaiToVertexRequest("gemini-2.0-flash", {
      messages: [
        { role: "assistant", content: null, reasoning_content: "hmm", tool_calls: [] },
        { role: "user", content: "hi" },
      ],
    }, true, { apiKey: "sk-secret-should-never-appear" });
    const sigs = JSON.stringify(out);
    expect(sigs).not.toContain("sk-secret-should-never-appear");
    const thoughtSigs = out.contents
      .flatMap((c) => c.parts || [])
      .filter((p) => p.thoughtSignature !== undefined)
      .map((p) => p.thoughtSignature);
    expect(thoughtSigs.length).toBeGreaterThan(0);
    for (const s of thoughtSigs) expect(s).toBe(DEFAULT_THINKING_VERTEX_SIGNATURE);
  });
});

describe("X67 vertex parallel same-name order", () => {
  it("parallel same-name calls keep order with ids stripped", () => {
    const out = openaiToVertexRequest("gemini-2.0-flash", {
      messages: [{
        role: "assistant", content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: '{"n":1}' } },
          { id: "c2", type: "function", function: { name: "f", arguments: '{"n":2}' } },
        ],
      }],
    }, true);
    const fcs = out.contents.flatMap((c) => c.parts || []).filter((p) => p.functionCall);
    expect(fcs).toHaveLength(2);
    expect(fcs[0].functionCall.args).toEqual({ n: 1 });
    expect(fcs[1].functionCall.args).toEqual({ n: 2 });
    expect("id" in fcs[0].functionCall).toBe(false);
  });
});

describe("X68 parallel_tool_calls false never trims commandcode history", () => {
  it("both tool-call blocks survive", () => {
    const out = openaiToCommandCodeRequest("m", {
      messages: [{
        role: "assistant", content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      }],
      parallel_tool_calls: false,
    }, true);
    const calls = out.params.messages.flatMap((m) => m.content || []).filter((b) => b.type === "tool-call");
    expect(calls).toHaveLength(2);
  });
});
