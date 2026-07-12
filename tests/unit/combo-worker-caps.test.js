import { describe, expect, it, vi } from "vitest";

import { createWorkerCapsResolver } from "../../src/sse/routing/comboCaps.js";
import {
  handleAutoChat,
  modelHasCaps,
} from "../../open-sse/routing/handleAutoChat.js";

function chatResponse(content) {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { headers: { "Content-Type": "application/json" } }
  );
}

describe("resolveWorkerCaps", () => {
  it("unions capabilities from nested combo members", async () => {
    const resolveWorkerCaps = createWorkerCapsResolver({
      findComboModels: async (model) =>
        model === "nested-combo" ? ["vision/model", "text/model"] : null,
      findCapabilities: (provider) =>
        provider === "vision"
          ? { vision: true, pdf: false, tools: false }
          : { vision: false, pdf: false, tools: true },
    });

    await expect(resolveWorkerCaps("nested-combo")).resolves.toEqual({
      vision: true,
      pdf: false,
      tools: true,
    });
  });

  it("returns plain-model capabilities unchanged", async () => {
    const findCapabilities = vi.fn(() => ({ vision: false, pdf: true, tools: false }));
    const resolveWorkerCaps = createWorkerCapsResolver({
      findComboModels: async () => null,
      findCapabilities,
    });

    await expect(resolveWorkerCaps("provider/plain-model")).resolves.toEqual({
      vision: false,
      pdf: true,
      tools: false,
    });
    expect(findCapabilities).toHaveBeenCalledWith("provider", "plain-model");
  });

  it("returns an empty capability object beyond the combo depth cap", async () => {
    const resolveWorkerCaps = createWorkerCapsResolver({
      findComboModels: async () => ["another-combo"],
    });

    await expect(resolveWorkerCaps("too-deep", 4)).resolves.toEqual({});
  });
});

describe("combo worker capability checks", () => {
  it("uses the union map for a combo worker", () => {
    const workerCaps = {
      "nested-combo": { vision: true, pdf: false, tools: true },
    };

    expect(modelHasCaps("nested-combo", ["vision"], workerCaps)).toBe(true);
    expect(modelHasCaps("nested-combo", ["pdf"], workerCaps)).toBe(false);
  });

  it("keeps a nested combo id in the Auto router pool", async () => {
    const calls = [];
    const nestedCombo = "nested-combo";
    const response = await handleAutoChat({
      body: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this image" },
              { type: "image_url", image_url: { url: "https://example.test/image.png" } },
            ],
          },
        ],
      },
      models: [nestedCombo, "openai/gpt-4o-mini", "router/model"],
      workerCaps: {
        [nestedCombo]: { vision: true, pdf: false, tools: true },
        "openai/gpt-4o-mini": { vision: false, pdf: false, tools: true },
      },
      handleSingleModel: async (body, model) => {
        calls.push({ body, model });
        if (body.max_tokens === 256) {
          return chatResponse(
            JSON.stringify({
              model: nestedCombo,
              cluster: "vision",
              confidence: "high",
              reason: "nested combo provides vision",
            })
          );
        }
        return chatResponse("nested worker response");
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "outer-auto",
      strategy: {
        routerModel: "router/model",
        explorationRate: 0,
        autoTuning: { heuristicFirst: false, cachedRoutes: false },
      },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent: () => {},
    });

    expect(response.ok).toBe(true);
    const routerCall = calls.find(({ body }) => body.max_tokens === 256);
    expect(routerCall.body.messages[1].content).toContain(nestedCombo);
    expect(routerCall.body.messages[1].content).toContain("caps:[vision,tools]");
    expect(calls.at(-1).model).toBe(nestedCombo);
  });
});
