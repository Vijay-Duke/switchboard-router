/**
 * Tests for #4202 and #4405
 *
 * #4202 — Codex registry has ghost models (always HTTP 400) and is missing
 *   gpt-daybreak-blue-latest / gpt-reserve.
 *   Fix: remove gpt-5.4/mini/spark entries + gpt-5.4-image; add gpt-daybreak-blue-latest and gpt-reserve.
 *
 * #4405 — Bare Codex model slugs (e.g. gpt-5.6-terra from the CLI /model picker)
 *   routed to provider "openai" instead of "codex", causing 404 for users without
 *   an OpenAI API key connection.
 *   Fix: add codex-specific gpt-5.x / gpt-6.x / gpt-daybreak-* / gpt-reserve* rules
 *   to MODEL_PREFIX_PROVIDERS before the generic gpt-* → openai rule.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { getModelInfoCore } from "../../open-sse/services/model.js";

// ── #4202 Registry checks ────────────────────────────────────────────────────

const codexSrc = fs.readFileSync(
  path.resolve("../open-sse/providers/registry/codex.js"),
  "utf-8"
);

describe("Codex registry — ghost models removed (#4202)", () => {
  it("gpt-5.4 is removed", () => {
    // Match only a standalone entry, not inside gpt-5.4-mini or gpt-5.45 etc.
    expect(codexSrc).not.toMatch(/id:\s*"gpt-5\.4"/);
  });

  it("gpt-5.4-mini is removed", () => {
    expect(codexSrc).not.toMatch(/id:\s*"gpt-5\.4-mini"/);
  });

  it("gpt-5.3-codex-spark is removed", () => {
    expect(codexSrc).not.toMatch(/id:\s*"gpt-5\.3-codex-spark"/);
  });

  it("gpt-5.4-image is removed", () => {
    expect(codexSrc).not.toMatch(/id:\s*"gpt-5\.4-image"/);
  });

  it("gpt-5.5 is removed", () => {
    expect(codexSrc).not.toMatch(/id:\s*"gpt-5\.5"/);
  });

  it("gpt-5.5-image is removed", () => {
    expect(codexSrc).not.toMatch(/id:\s*"gpt-5\.5-image"/);
  });

  it("gpt-5.3-image is removed", () => {
    expect(codexSrc).not.toMatch(/id:\s*"gpt-5\.3-image"/);
  });
});

describe("Codex registry — new models added (#4202)", () => {
  it("gpt-daybreak-blue-latest is present", () => {
    expect(codexSrc).toContain('"gpt-daybreak-blue-latest"');
  });

  it("gpt-reserve is present", () => {
    expect(codexSrc).toContain('"gpt-reserve"');
  });
});

describe("Codex registry — still-live models kept (#4202 regression guard)", () => {
  it("gpt-5.6-sol still present", () => {
    expect(codexSrc).toContain('"gpt-5.6-sol"');
  });

  it("gpt-5.6-terra still present", () => {
    expect(codexSrc).toContain('"gpt-5.6-terra"');
  });

  it("gpt-6-astra still present", () => {
    expect(codexSrc).toContain('"gpt-6-astra"');
  });
});

// ── #4405 Model prefix routing ───────────────────────────────────────────────
// Switchboard: exercises the real resolver instead of a copied regex table, and
// only Codex-registry-exclusive ids route to codex — OpenAI API ids (gpt-5.4,
// gpt-5) stay on openai so API-key users are not hijacked onto OAuth Codex.

const inferProvider = async (model) => (await getModelInfoCore(model, {})).provider;

describe("bare model routing — Codex-only gpt-* models route to codex (#4405)", () => {
  it.each([
    "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol",
    "gpt-daybreak-blue-latest", "gpt-reserve", "codex-auto-review",
  ])("%s → codex", async (model) => {
    expect(await inferProvider(model)).toBe("codex");
  });

  it.each(["gpt-5.5", "gpt-5.4", "gpt-5", "gpt-5-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo", "gpt-5.9-unknown"])(
    "%s → openai (OpenAI API / unknown ids unaffected)",
    async (model) => {
      expect(await inferProvider(model)).toBe("openai");
    },
  );

  it("claude-opus-5 → anthropic (regression guard)", async () => {
    expect(await inferProvider("claude-opus-5")).toBe("anthropic");
  });
});
