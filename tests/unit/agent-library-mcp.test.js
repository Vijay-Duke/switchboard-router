// @ts-check
// T5: MCP stdio args must survive quoted shell words (round trip through the
// library form and the server list display).
import { describe, expect, it } from "vitest";
import {
  splitShellWords,
  formatShellWords,
} from "../../src/app/(dashboard)/dashboard/agent-library/shellWords.js";

describe("splitShellWords (T5)", () => {
  it("splits plain space-separated args", () => {
    expect(splitShellWords("-y @modelcontextprotocol/server-filesystem .")).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      ".",
    ]);
  });

  it("keeps double-quoted args with spaces as one arg", () => {
    expect(splitShellWords('--header "Authorization: Bearer x" --verbose')).toEqual([
      "--header",
      "Authorization: Bearer x",
      "--verbose",
    ]);
  });

  it("keeps single-quoted args as one arg", () => {
    expect(splitShellWords("--path '/Users/you/my app'")).toEqual(["--path", "/Users/you/my app"]);
  });

  it("honors backslash escapes", () => {
    expect(splitShellWords('a\\ b "c\\"d"')).toEqual(["a b", 'c"d']);
  });

  it("preserves empty quoted words and ignores extra whitespace", () => {
    expect(splitShellWords("  ''  x\t")).toEqual(["", "x"]);
  });
});

describe("formatShellWords (T5 display round-trip)", () => {
  it("quotes words containing spaces so they survive a re-split", () => {
    const args = ["--header", "Authorization: Bearer x", "--verbose"];
    const formatted = formatShellWords(args);
    expect(formatted).toBe('--header "Authorization: Bearer x" --verbose');
    expect(splitShellWords(formatted)).toEqual(args);
  });

  it("leaves simple words untouched", () => {
    expect(formatShellWords(["-y", "pkg"])).toBe("-y pkg");
  });
});
