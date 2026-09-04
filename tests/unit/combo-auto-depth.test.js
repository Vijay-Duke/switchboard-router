import { describe, it, expect, vi } from "vitest";

import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";
import { handleAutoChat, isCheapTierEscalation } from "../../open-sse/routing/handleAutoChat.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function okResponse(content) {
  const json = { choices: [{ message: { role: "assistant", content } }], usage: { completion_tokens: 1 } };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json, headers: new Map(), body: null });
  return make();
}

describe("combined auto+combo depth cap (E7)", () => {
  it("combo rejects when comboDepth + autoDepth exceeds the cap", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("x"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel,
      log,
      childComboDepth: 2,
      autoDepth: 2,
    });
    expect(res.status).toBe(400);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });

  it("combo still runs at exactly the cap with no outer auto depth", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("x"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel,
      log,
      childComboDepth: 3,
    });
    expect(res.ok).toBe(true);
  });

  it("fusion rejects over-cap combined depth", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("x"));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      childComboDepth: 3,
      autoDepth: 1,
    });
    expect(res.status).toBe(400);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });

  it("combo forwards both counters to nested calls", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, opts) => {
      seen.push(opts);
      return okResponse("x");
    });
    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel,
      log,
      childComboDepth: 1,
      autoDepth: 1,
    });
    expect(seen[0].comboDepth).toBe(1);
    expect(seen[0].autoDepth).toBe(1);
  });

  it("auto rejects when autoDepth + comboDepth reaches the cap", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("x"));
    const res = await handleAutoChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel,
      log,
      comboName: "auto-x",
      strategy: {},
      autoDepth: 1,
      comboDepth: 2,
    });
    expect(res.status).toBe(400);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });

  it("auto keeps its standalone cap (autoDepth 2, no combo depth)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("x"));
    const res = await handleAutoChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel,
      log,
      comboName: "auto-x",
      strategy: {},
      autoDepth: 2,
    });
    expect(res.status).toBe(400);
  });
});

describe("cheap-tier escalation status gate (E8)", () => {
  const split = { cheap: ["cheap-a"], frontier: ["frontier-b"] };

  it("escalates on retriable statuses", () => {
    for (const status of [429, 408, 500, 502, 503, 504]) {
      expect(isCheapTierEscalation(split, "cheap-a", status)).toBe(true);
    }
  });

  it("does not escalate on deterministic client errors", () => {
    for (const status of [400, 401, 402, 403, 404, 499]) {
      expect(isCheapTierEscalation(split, "cheap-a", status)).toBe(false);
    }
  });

  it("fails open on unknown status, closed on non-cheap/disabled/empty", () => {
    expect(isCheapTierEscalation(split, "cheap-a", null)).toBe(true);
    expect(isCheapTierEscalation(split, "frontier-b", 429)).toBe(false);
    expect(isCheapTierEscalation({ ...split, disabled: true }, "cheap-a", 429)).toBe(false);
    expect(isCheapTierEscalation({ cheap: ["cheap-a"], frontier: [] }, "cheap-a", 429)).toBe(false);
    expect(isCheapTierEscalation(null, "cheap-a", 429)).toBe(false);
  });
});
