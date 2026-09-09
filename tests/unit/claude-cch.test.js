import { describe, it, expect } from "vitest";
import { xxHash64, signClaudeBodyCch } from "../../open-sse/utils/claudeCch.js";

describe("xxHash64 (reference vectors)", () => {
  it("matches xxhsum for canonical inputs", () => {
    const vectors = [
      ["", "ef46db3751d8e999"],
      ["a", "d24ec4f1a98c6e5b"],
      ["abc", "44bc2cf5ad770999"],
      ["xxhash", "32dd38952c4bc720"],
      ["Call me Ishmael. Some years ago--never mind how long precisely-", "02a2e85470d6fd96"],
    ];
    for (const [input, expected] of vectors) {
      expect(xxHash64(Buffer.from(input, "utf8"), 0n).toString(16).padStart(16, "0")).toBe(expected);
    }
  });
});

describe("signClaudeBodyCch", () => {
  const billing = (cch) =>
    `x-anthropic-billing-header: cc_version=2.1.263.abc; cc_entrypoint=cli; cch=${cch};`;

  it("signs the billing block: zeroed-view hash over normalized body", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: billing("00000") }],
      model: "claude-fable-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    const signed = signClaudeBodyCch(body).toString("utf8");
    const cch = signed.match(/cch=([0-9a-f]{5});/)[1];
    expect(cch).not.toBe("00000");
    // idempotence: re-signing the signed body (view zeroes cch) yields same value
    expect(signClaudeBodyCch(signed).toString("utf8")).toBe(signed);
  });

  it("is stable regardless of model id and max_tokens (they are excluded from the view)", () => {
    const mk = (model, maxTokens) => JSON.stringify({
      system: [{ type: "text", text: billing("00000") }],
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: "hi" }],
    });
    const a = signClaudeBodyCch(mk("claude-opus-5", 16)).toString("utf8");
    const b = signClaudeBodyCch(mk("claude-fable-5", 1024)).toString("utf8");
    expect(a.match(/cch=([0-9a-f]{5});/)[1]).toBe(b.match(/cch=([0-9a-f]{5});/)[1]);
  });

  it("returns the body unchanged when no billing block is present", () => {
    const body = JSON.stringify({ model: "x", messages: [] });
    expect(signClaudeBodyCch(body).toString("utf8")).toBe(body);
  });

  it("handles multibyte content byte-exactly", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: billing("00000") }],
      model: "claude-opus-5",
      messages: [{ role: "user", content: "héllo wörld 🎉" }],
    });
    const signed = signClaudeBodyCch(body).toString("utf8");
    expect(signed.match(/cch=([0-9a-f]{5});/)).not.toBeNull();
    // JSON round-trips (no corruption from byte surgery)
    expect(() => JSON.parse(signed)).not.toThrow();
  });
});
