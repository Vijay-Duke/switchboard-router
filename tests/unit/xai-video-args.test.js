import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseArgs } = require("../../cli/src/cli/commands/xaiVideo.js");

describe("xaiVideo parseArgs missing values (L5)", () => {
  it("throws on bare --prompt", () => {
    expect(() => parseArgs(["--prompt"])).toThrow(/--prompt requires a value/);
  });

  it("throws on bare --output", () => {
    expect(() => parseArgs(["--prompt", "hi", "--output"])).toThrow(/--output requires a value/);
  });

  it("throws on bare --duration", () => {
    expect(() => parseArgs(["--prompt", "hi", "--duration"])).toThrow(/--duration requires a value/);
  });

  it("throws when the next token is another flag", () => {
    expect(() => parseArgs(["--prompt", "--output", "x.mp4"])).toThrow(/--prompt requires a value/);
    expect(() => parseArgs(["--prompt", "hi", "--model"])).toThrow(/--model requires a value/);
  });

  it("still parses valid args", () => {
    const opts = parseArgs(["--prompt", "hi", "--output", "o.mp4"]);
    expect(opts.prompt).toBe("hi");
    expect(opts.output).toBe("o.mp4");
  });
});
