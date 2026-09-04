// O8: colorLine reads the first [LEVEL] tag's capture group.

import { describe, expect, it } from "vitest";
import { colorLine } from "@/app/(dashboard)/dashboard/console-log/ConsoleLogClient";

describe("colorLine (O8)", () => {
  it.each([
    ["[ERROR] boom", "text-red-400"],
    ["[WARN] careful", "text-yellow-400"],
    ["[INFO] hello", "text-blue-400"],
    ["[DEBUG] [foo] two tags", "text-purple-400"],
    ["plain line", "text-green-400"],
  ])("%s -> %s", (line, className) => {
    const el = colorLine(line);
    expect(el.props.className).toBe(className);
    expect(el.props.children).toBe(line);
  });
});
