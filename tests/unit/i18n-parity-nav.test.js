/**
 * i18n nav parity: every `label` in Sidebar NAV_SECTIONS must exist as a
 * literal key in zh-CN.json, otherwise Chinese-locale users see a
 * half-translated nav (translation is literal-string keyed).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function sidebarLabels() {
  const source = stripComments(
    readFileSync(join(root, "src", "shared", "components", "Sidebar.js"), "utf8")
  );
  return [...source.matchAll(/label:\s*"([^"]+)"/g)].map((match) => match[1]);
}

function zhKeys() {
  return new Set(
    Object.keys(
      JSON.parse(readFileSync(join(root, "public", "i18n", "literals", "zh-CN.json"), "utf8"))
    )
  );
}

describe("i18n parity: sidebar nav labels", () => {
  it("extracts at least the known nav labels", () => {
    const labels = sidebarLabels();
    for (const expected of ["Operate", "Overview", "Agent library", "CLI tools"]) {
      expect(labels).toContain(expected);
    }
  });

  it("covers every Sidebar label in zh-CN.json", () => {
    const keys = zhKeys();
    const missing = sidebarLabels().filter((label) => !keys.has(label));
    expect(missing).toEqual([]);
  });
});
