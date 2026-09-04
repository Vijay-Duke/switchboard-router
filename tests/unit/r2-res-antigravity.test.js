/** Round-2 response findings: openai-to-antigravity/gemini (R1-X19..X25, R2-X37/X38). */
import { describe, it, expect } from "vitest";
import { openaiToAntigravityResponse } from "../../open-sse/translator/response/openai-to-antigravity.js";

function fresh() {
  return {};
}

function feed(events, state = fresh()) {
  const all = [];
  for (const e of events) {
    const out = openaiToAntigravityResponse(e, state);
    if (out) all.push(out);
  }
  return { state, out: all };
}

const chunk = (delta, finish = null, extra = {}) => ({
  id: "chatcmpl-1", model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
});
const partsOf = (r) => r.response.candidates[0].content.parts;

describe("R1-X19/R2-X37 hub error finish", () => {
  it("error -> MALFORMED_FUNCTION_CALL; other mappings unchanged", () => {
    const { out } = feed([chunk({ content: "x" }, "error")]);
    expect(out[0].response.candidates[0].finishReason).toBe("MALFORMED_FUNCTION_CALL");
    for (const [hub, want] of [["stop", "STOP"], ["length", "MAX_TOKENS"], ["tool_calls", "STOP"], ["content_filter", "SAFETY"]]) {
      const r = feed([chunk({}, hub)]);
      expect(r.out[0].response.candidates[0].finishReason).toBe(want);
    }
  });
});

describe("R1-X20/R2-X38 think markers", () => {
  it("lone markers dropped; spans become thought parts", () => {
    const { out } = feed([
      chunk({ content: "<think>" }),
      chunk({ reasoning_content: "plan" }),
      chunk({ content: "</think>" }),
      chunk({ content: "hello" }),
    ]);
    const parts = out.flatMap(partsOf);
    expect(parts.some((p) => p.text === "<think>" || p.text === "</think>")).toBe(false);
    expect(parts).toContainEqual({ thought: true, text: "plan" });
    expect(parts).toContainEqual({ text: "hello" });

    const { out: out2 } = feed([chunk({ content: "a<think>secret</think>b" })]);
    const parts2 = out2.flatMap(partsOf);
    expect(parts2).toContainEqual({ thought: true, text: "secret" });
    expect(JSON.stringify(parts2)).not.toContain("<think>");
  });
});

describe("R1-X21 reasoning shapes", () => {
  it("reasoning_content, reasoning, reasoning_details all emit thought parts", () => {
    for (const delta of [
      { reasoning_content: "r1" },
      { reasoning: "r2" },
      { reasoning_details: [{ text: "r3" }] },
    ]) {
      const { out } = feed([chunk(delta)]);
      expect(out.flatMap(partsOf)).toContainEqual({ thought: true, text: expect.stringContaining("r") });
    }
  });
});

describe("R1-X22 truncated args marker", () => {
  it("bad JSON emits {} plus marker; valid JSON emits no marker", () => {
    const trunc = feed([
      chunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "Edit", arguments: '{"file":"a","ed' } }] }),
      chunk({}, "tool_calls"),
    ]);
    const calls = trunc.out.flatMap(partsOf).filter((p) => p.functionCall);
    expect(calls[0].functionCall.args).toEqual({});
    expect(trunc.out.flatMap(partsOf)).toContainEqual({ text: "[tool arguments truncated in transit]" });

    const valid = feed([
      chunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "Edit", arguments: '{"file":"a"}' } }] }),
      chunk({}, "tool_calls"),
    ]);
    expect(JSON.stringify(valid.out)).not.toContain("truncated in transit");
  });
});

describe("R1-X23 name fragments", () => {
  const run = (names) => {
    const evts = names.map((n) => chunk({ tool_calls: [{ index: 0, function: { name: n } }] }));
    evts.push(chunk({ tool_calls: [{ index: 0, id: "t1", function: { arguments: "{}" } }] }, "tool_calls"));
    return feed(evts);
  };
  it("look+lookup -> lookup; lookup+lookup -> lookup; loo+kup -> lookup", () => {
    expect(run(["look", "lookup"]).out.flatMap(partsOf).find((p) => p.functionCall).functionCall.name).toBe("lookup");
    expect(run(["lookup", "lookup"]).out.flatMap(partsOf).find((p) => p.functionCall).functionCall.name).toBe("lookup");
    expect(run(["loo", "kup"]).out.flatMap(partsOf).find((p) => p.functionCall).functionCall.name).toBe("lookup");
  });
});

describe("R1-X24 EOF on virgin state", () => {
  it("returns null; EOF after text synthesizes STOP", () => {
    expect(openaiToAntigravityResponse(null, fresh())).toBeNull();
    const state = fresh();
    feed([chunk({ content: "hi" })], state);
    const flushed = openaiToAntigravityResponse(null, state);
    expect(flushed.response.candidates[0].finishReason).toBe("STOP");
  });
});

describe("R1-X25 trailing usage after finish", () => {
  it("yields a response carrying usageMetadata", () => {
    const state = fresh();
    feed([chunk({ content: "hi" }, "stop")], state);
    const out = openaiToAntigravityResponse(
      { usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }, state
    );
    expect(out.response.usageMetadata.promptTokenCount).toBe(9);
  });
});

describe("gemini image deltas reach inlineData", () => {
  it("content image_url block becomes inlineData part", () => {
    const { out } = feed([chunk({ content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] })]);
    expect(out.flatMap(partsOf)).toContainEqual({ inlineData: { mime_type: "image/png", data: "QUJD" } });
  });
  it("legacy delta.images also forwarded", () => {
    const { out } = feed([{ id: "c", model: "m", choices: [{ index: 0, delta: { images: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }, finish_reason: null }] }]);
    expect(out.flatMap(partsOf)).toContainEqual({ inlineData: { mime_type: "image/png", data: "QUJD" } });
  });
});
