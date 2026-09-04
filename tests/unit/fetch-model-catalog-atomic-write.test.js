import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../scripts/fetch-model-catalog.mjs";

let dir;
let out;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-catalog-write-"));
  out = path.join(dir, "catalog.json");
  fs.writeFileSync(out, '{"original":true}\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("fetch-model-catalog atomic write (L4)", () => {
  it("replaces the target via tmp + rename and leaves no tmp behind", async () => {
    await writeFileAtomic(out, '{"fresh":true}\n');
    expect(fs.readFileSync(out, "utf8")).toBe('{"fresh":true}\n');
    expect(fs.existsSync(`${out}.tmp`)).toBe(false);
  });

  it("keeps the original intact when the tmp write fails", async () => {
    // A directory squatting on the tmp path makes writeFile fail (EISDIR).
    fs.mkdirSync(`${out}.tmp`);
    await expect(writeFileAtomic(out, '{"partial":true}\n')).rejects.toThrow();
    expect(fs.readFileSync(out, "utf8")).toBe('{"original":true}\n');
  });

  it("keeps the original intact when the rename fails", async () => {
    // Renaming a file over a non-empty directory fails; the target file
    // itself is untouched and the tmp is cleaned up.
    const target = path.join(dir, "occupied");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "child"), "x");
    await expect(writeFileAtomic(target, "data")).rejects.toThrow();
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
    expect(fs.readFileSync(out, "utf8")).toBe('{"original":true}\n');
  });
});
