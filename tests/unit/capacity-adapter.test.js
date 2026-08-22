import { describe, it, expect, vi } from "vitest";

// Mock capabilities: claude-sonnet has vision + small context to exercise stripping;
// everything else is text-only. This isolates tests from the real registry.
vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: (provider, model) => {
    const base = model.includes("/") ? model.split("/").pop() : model;
    return {
      vision: base.includes("claude-sonnet"),
      pdf: false,
      audioInput: false,
      videoInput: false,
      contextWindow: base.includes("claude-sonnet") ? 2000 : 128000,
    };
  },
}));

import {
  getCapacityAdapterConfig,
  getCapacityAdapterModels,
  getCapacityAdapterStrategy,
  getActiveAdapterStrategy,
  augmentModelsWithCapacityAdapter,
  stripHistoryForContext,
  withCapacityAdapterStripping,
} from "../../open-sse/services/capacityAdapter.js";

const VISION_MODEL = "anthropic/claude-sonnet-4.6";
const TEXT_MODEL = "deepseek/deepseek-chat";

const settingsWith = (cap, entry) => ({
  capacityAdapter: {
    vision: { enabled: false, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: false, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
    [cap]: entry,
  },
});

describe("getCapacityAdapterConfig", () => {
  it("normalizes the legacy array form [{model, enabled}] to an enabled pool", () => {
    const cfg = getCapacityAdapterConfig("vision", settingsWith("vision", [
      { model: VISION_MODEL, enabled: true },
      TEXT_MODEL,
    ]));
    expect(cfg).toEqual({ enabled: true, roundRobin: false, models: [VISION_MODEL, TEXT_MODEL] });
  });

  it("injects the default fallback model into an enabled pool with no models", () => {
    const cfg = getCapacityAdapterConfig("vision", settingsWith("vision", { enabled: true, roundRobin: false, models: [] }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.models).toEqual(["oc/mimo-v2.5-free"]);
  });

  it("leaves a disabled empty pool empty (no default injection)", () => {
    const cfg = getCapacityAdapterConfig("vision", undefined);
    expect(cfg).toEqual({ enabled: false, roundRobin: false, models: [] });
  });
});

describe("getCapacityAdapterModels", () => {
  it("flattens enabled pools in priority order, deduped across pools", () => {
    const settings = {
      capacityAdapter: {
        vision: { enabled: true, roundRobin: false, models: ["a/x", "b/y"] },
        pdf: { enabled: true, roundRobin: false, models: ["a/x", "c/z"] },
        audioInput: { enabled: false, roundRobin: false, models: ["d/w"] },
        videoInput: { enabled: false, roundRobin: false, models: [] },
      },
    };
    expect(getCapacityAdapterModels(settings)).toEqual(["a/x", "b/y", "c/z"]);
  });

  it("returns [] when no settings", () => {
    expect(getCapacityAdapterModels(undefined)).toEqual([]);
    expect(getCapacityAdapterModels({})).toEqual([]);
  });
});

describe("strategies", () => {
  it("round-robin only when enabled and flagged", () => {
    expect(getCapacityAdapterStrategy("vision", settingsWith("vision", { enabled: true, roundRobin: true, models: [VISION_MODEL] }))).toBe("round-robin");
    expect(getCapacityAdapterStrategy("vision", settingsWith("vision", { enabled: true, roundRobin: false, models: [VISION_MODEL] }))).toBe("fallback");
    expect(getCapacityAdapterStrategy("vision", settingsWith("vision", { enabled: false, roundRobin: true, models: [VISION_MODEL] }))).toBe("fallback");
  });

  it("active strategy follows the first satisfiable required capability", () => {
    const rr = settingsWith("vision", { enabled: true, roundRobin: true, models: [VISION_MODEL] });
    expect(getActiveAdapterStrategy(new Set(["search", "vision"]), rr)).toBe("round-robin");
    // disabled pool -> plain fallback
    const off = settingsWith("vision", { enabled: false, roundRobin: true, models: [VISION_MODEL] });
    expect(getActiveAdapterStrategy(new Set(["vision"]), off)).toBe("fallback");
  });
});

describe("augmentModelsWithCapacityAdapter", () => {
  it("prepends a capable adapter model (priority) when no original model satisfies vision", () => {
    const settings = settingsWith("vision", [{ model: VISION_MODEL, enabled: true }]);
    const out = augmentModelsWithCapacityAdapter([TEXT_MODEL], new Set(["vision"]), settings);
    expect(out).toEqual([VISION_MODEL, TEXT_MODEL]);
  });

  it("leaves models untouched when an original model already satisfies the cap", () => {
    const settings = settingsWith("vision", [{ model: VISION_MODEL, enabled: true }]);
    const out = augmentModelsWithCapacityAdapter([VISION_MODEL, TEXT_MODEL], new Set(["vision"]), settings);
    expect(out).toEqual([VISION_MODEL, TEXT_MODEL]);
  });

  it("skips disabled adapter entries", () => {
    const settings = settingsWith("vision", { enabled: false, roundRobin: false, models: [VISION_MODEL] });
    const out = augmentModelsWithCapacityAdapter([TEXT_MODEL], new Set(["vision"]), settings);
    expect(out).toEqual([TEXT_MODEL]);
  });

  it("skips adapter models that don't satisfy the required cap", () => {
    // adapter pool only has a text model -> useless for vision
    const settings = settingsWith("vision", [{ model: TEXT_MODEL, enabled: true }]);
    const out = augmentModelsWithCapacityAdapter([TEXT_MODEL], new Set(["vision"]), settings);
    expect(out).toEqual([TEXT_MODEL]);
  });

  it("no required capabilities -> unchanged", () => {
    const settings = settingsWith("vision", [{ model: VISION_MODEL, enabled: true }]);
    const out = augmentModelsWithCapacityAdapter([TEXT_MODEL], new Set(), settings);
    expect(out).toEqual([TEXT_MODEL]);
  });

  it("filters to hard caps only (ignores soft caps like search)", () => {
    const settings = settingsWith("vision", [{ model: VISION_MODEL, enabled: true }]);
    const out = augmentModelsWithCapacityAdapter([TEXT_MODEL], new Set(["search"]), settings);
    expect(out).toEqual([TEXT_MODEL]);
  });
});

describe("stripHistoryForContext", () => {
  const big = "x".repeat(10000);

  it("keeps system + trailing user turn, drops oldest when over budget", () => {
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] },
      ],
    };
    // Tiny budget forces dropping. ~4000 chars budget.
    const out = stripHistoryForContext(body, 2000);
    // System + the last (image) user turn must always survive.
    expect(out.messages[0]).toMatchObject({ role: "system" });
    expect(out.messages.at(-1)).toMatchObject({ role: "user" });
    expect(out.messages.length).toBeLessThan(body.messages.length);
  });

  it("returns body unchanged when already within budget", () => {
    const body = { messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "again" },
    ] };
    expect(stripHistoryForContext(body, 200000)).toBe(body);
  });

  it("no-op on unsupported shape", () => {
    const body = { foo: 1 };
    expect(stripHistoryForContext(body, 1000)).toBe(body);
  });

  it("handles gemini contents/parts shape", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: big }] },
        { role: "model", parts: [{ text: big }] },
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] },
      ],
    };
    const out = stripHistoryForContext(body, 2000);
    expect(out.contents.at(-1).role).toBe("user");
    expect(out.contents.length).toBeLessThan(body.contents.length);
  });
});

describe("withCapacityAdapterStripping", () => {
  it("strips history only for adapter models", async () => {
    const seen = [];
    const inner = vi.fn(async (body, modelStr) => {
      seen.push({ model: modelStr, len: body.messages?.length });
      return { ok: true };
    });
    const wrapped = withCapacityAdapterStripping(inner, [VISION_MODEL]);

    const big = "x".repeat(10000);
    const body = {
      messages: [
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
      ],
    };

    // Adapter model -> history stripped (fewer messages)
    await wrapped(body, VISION_MODEL);
    expect(seen[0].len).toBeLessThan(body.messages.length);

    // Non-adapter model -> body untouched (same length)
    await wrapped(body, TEXT_MODEL);
    expect(seen[1].len).toBe(body.messages.length);
  });

  it("forwards extra dispatch args untouched (callOpts pass-through)", async () => {
    const inner = vi.fn(async () => ({ ok: true }));
    const wrapped = withCapacityAdapterStripping(inner, [VISION_MODEL]);
    await wrapped({}, TEXT_MODEL, { signal: "s", comboDepth: 2 });
    expect(inner.mock.calls[0][2]).toEqual({ signal: "s", comboDepth: 2 });
  });

  it("passthrough when adapterModels empty", async () => {
    const inner = vi.fn(async () => ({ ok: true }));
    const wrapped = withCapacityAdapterStripping(inner, []);
    expect(wrapped).toBe(inner);
  });
});
