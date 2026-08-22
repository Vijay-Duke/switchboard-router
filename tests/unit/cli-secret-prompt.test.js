import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { promptSecret } = require("../../cli/src/cli/utils/input.js");

describe("CLI client-key prompt", () => {
  it("never echoes the supplied reusable secret", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const originalRaw = process.stdin.setRawMode;
    process.stdin.setRawMode = vi.fn();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const pending = promptSecret("Secret: ");
    process.stdin.emit("data", "sk-do-not-echo\r");
    await expect(pending).resolves.toBe("sk-do-not-echo");
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).not.toContain("sk-do-not-echo");
    expect(output).toContain("**************");
    write.mockRestore();
    process.stdin.setRawMode = originalRaw;
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
  });
});
