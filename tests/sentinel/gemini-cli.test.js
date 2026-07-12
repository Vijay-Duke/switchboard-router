import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { request, upstreamChunks } from "./fixtures/gemini-cli.js";
import { assertGolden, runResponseStream } from "./helpers.js";

describe("Gemini CLI wire compatibility", () => {
  it("request -> gemini upstream body", () => {
    const out = translateRequest(
      FORMATS.GEMINI_CLI,
      FORMATS.GEMINI,
      "gemini-2.5-pro",
      request,
      true,
      { apiKey: "k" },
      "gemini"
    );

    // Structural guards run BEFORE assertGolden: under UPDATE_GOLDEN=1 a regen
    // must not persist a golden for a payload that violates these invariants.
    // URL-controlled-streaming regression guard: the URL, not the body, selects streaming.
    expect(out).not.toHaveProperty("stream");
    expect(Object.keys(out)).not.toContain("stream");
    expect(out.contents).toBeDefined();
    assertGolden("gemini-cli.request", out);
  });

  it("response -> gemini-cli mapping", () => {
    const events = runResponseStream(
      FORMATS.GEMINI,
      FORMATS.GEMINI_CLI,
      upstreamChunks
    );

    // Structural guards run BEFORE assertGolden: under UPDATE_GOLDEN=1 a regen
    // must not persist a golden for a payload that violates these invariants.
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    assertGolden("gemini-cli.response", events);
  });
});
