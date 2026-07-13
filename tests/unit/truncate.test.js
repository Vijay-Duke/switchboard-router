import { describe, expect, it } from "vitest";
import {
  byteSafePrefix,
  charSafePrefix,
  charSafeSuffix,
} from "../../open-sse/utils/truncate.js";

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function expectWellFormed(result) {
  expect(JSON.parse(JSON.stringify(result))).toBe(result);
  expect(LONE_SURROGATE_RE.test(result)).toBe(false);
}

describe("surrogate-safe truncation", () => {
  it("caps prefixes by UTF-16 code units without splitting astral characters", () => {
    const cases = [
      ["a😀b", 2, "a"],
      ["a😀b", 3, "a😀"],
      ["abc", 2, "ab"],
      ["ab", 5, "ab"],
      ["x𝔘y", 2, "x"],
      ["x𠮷y", 3, "x𠮷"],
    ];

    for (const [input, cap, expected] of cases) {
      const result = charSafePrefix(input, cap);
      expect(result).toBe(expected);
      expectWellFormed(result);
    }
  });

  it("caps suffixes by UTF-16 code units without starting on a low surrogate", () => {
    const cases = [
      ["a😀b", 2, "b"],
      ["a𝔘b", 3, "𝔘b"],
      ["a𠮷b", 2, "b"],
    ];

    for (const [input, cap, expected] of cases) {
      const result = charSafeSuffix(input, cap);
      expect(result).toBe(expected);
      expectWellFormed(result);
    }
  });

  it("caps prefixes by UTF-8 bytes and backs off multibyte boundaries", () => {
    const cases = [
      ["😀😀", 4, "😀"],
      ["hello", 3, "hel"],
      ["a𝔘b", 4, "a"],
      ["𠮷x", 4, "𠮷"],
      ["𠮷x", 3, ""],
      ["😀", 0, ""],
    ];

    for (const [input, cap, expected] of cases) {
      const result = byteSafePrefix(input, cap);
      expect(result).toBe(expected);
      expectWellFormed(result);
    }
  });

  it("returns an empty string for non-string input", () => {
    for (const truncate of [charSafePrefix, charSafeSuffix, byteSafePrefix]) {
      const result = truncate(null, 10);
      expect(result).toBe("");
      expectWellFormed(result);
    }
  });
});
