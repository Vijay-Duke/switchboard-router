import { describe, expect, it } from "vitest";

import { translateRequest } from "../../open-sse/translator/index.js";

describe("translator input hardening", () => {
  it("ignores null content parts while applying modality stripping", () => {
    expect(() => translateRequest(
      "openai",
      "openai",
      "test-model",
      { messages: [{ role: "user", content: [null, { type: "text", text: "hello" }] }] },
      true,
      null,
      "openai",
      null,
      ["image", "audio"],
    )).not.toThrow();
  });
});
