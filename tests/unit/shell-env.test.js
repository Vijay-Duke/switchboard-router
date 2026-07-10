import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseQuotedShellValue, quoteShellValue } from "../../src/lib/cli/shellEnv.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("shell env encoding", () => {
  it("round-trips quotes and shell metacharacters without executing them", async () => {
    const value = "key'\"$(printf PWNED); `uname`; $HOME";
    const encoded = quoteShellValue(value);
    expect(parseQuotedShellValue(encoded)).toBe(value);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "switchboard-shell-env-"));
    tempDirs.push(dir);
    const envPath = path.join(dir, "switchboard.env");
    await fs.writeFile(envPath, `export TEST_VALUE=${encoded}\n`);
    const actual = execFileSync("/bin/sh", ["-c", '. "$1"; printf %s "$TEST_VALUE"', "sh", envPath], {
      encoding: "utf8",
    });
    expect(actual).toBe(value);
  });
});
