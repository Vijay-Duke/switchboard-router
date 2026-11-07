import { describe, expect, it, vi } from "vitest";

import gemini from "../../open-sse/handlers/imageProviders/gemini.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const B64 = "iVBORw0KGgo" + "A".repeat(120);

describe("Gemini image reference inputs", () => {
  it("prepends a data-URI reference image as inlineData", () => {
    const body = gemini.buildBody("gemini-3.1-flash-image-preview", { prompt: "make it blue", image: `data:image/jpeg;base64,${B64}` });
    expect(body.contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/jpeg", data: B64 } },
      { text: "make it blue" },
    ]);
  });

  it("accepts raw base64 from images[] and ignores http URLs", () => {
    expect(gemini.buildBody("m", { prompt: "p", images: [B64] }).contents[0].parts[0])
      .toEqual({ inlineData: { mimeType: "image/png", data: B64 } });
    expect(gemini.buildBody("m", { prompt: "p", image: "https://example.com/a.png" }).contents[0].parts)
      .toEqual([{ text: "p" }]);
  });
});

describe("Antigravity image executor keeps reference images", () => {
  it("forwards inlineData parts alongside the prompt", () => {
    const out = new AntigravityExecutor().transformRequest("gemini-3.1-flash-image-16x9", {
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: B64 } }, { text: "edit" }] }],
    }, false, { projectId: "p" });
    expect(out.request.contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/png", data: B64 } },
      { text: "edit" },
    ]);
  });
});

describe("Antigravity image adapter errors", () => {
  it("carries the upstream status and quota reset", async () => {
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const errorBody = JSON.stringify({ error: { code: 429, details: [{ metadata: { quotaResetTimeStamp: reset } }] } });
    const executor = { execute: vi.fn(async () => ({ response: new Response(errorBody, { status: 429 }) })) };
    vi.resetModules();
    vi.doMock("../../open-sse/executors/index.js", () => ({ getExecutor: () => executor }));
    const { default: adapter } = await import("../../open-sse/handlers/imageProviders/antigravity.js");
    const err = await adapter.executeViaExecutor("gemini-3.1-flash-image", { prompt: "x" }, {}, null).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.resetsAtMs).toBe(Date.parse(reset));
    vi.doUnmock("../../open-sse/executors/index.js");
  });
});
