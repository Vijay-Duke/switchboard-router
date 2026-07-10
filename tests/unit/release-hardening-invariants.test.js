import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function jsFilesUnder(relativeDir) {
  const dir = path.join(root, relativeDir);
  return fs.readdirSync(dir, { recursive: true })
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dir, name));
}

describe("release hardening invariants", () => {
  it("never discovers app processes through broad command-line substring scans", () => {
    const cli = read("cli/cli.js");
    const updater = read("src/lib/appUpdater.js");
    expect(cli).toContain("owned-processes.json");
    expect(updater).toContain("owned-processes.json");
    expect(`${cli}\n${updater}`).not.toMatch(/includes\(["']next-server["']\)|ps aux/);
  });

  it("persists sql.js through fsync and atomic rename", () => {
    const source = read("src/lib/db/adapters/sqljsAdapter.js");
    expect(source).toContain("fs.fsyncSync(fileFd)");
    expect(source).toContain("fs.closeSync(fileFd)");
    expect(source).toContain("fs.renameSync(tmp, filePath)");
  });

  it("does not grant wildcard CORS on gateway routes or responses", () => {
    const files = [
      ...jsFilesUnder("src/app/api/v1"),
      ...jsFilesUnder("src/app/api/v1beta"),
      path.join(root, "src/app/api/tags/route.js"),
      path.join(root, "src/app/api/health/route.js"),
      ...jsFilesUnder("open-sse"),
    ];
    for (const file of files) {
      expect(fs.readFileSync(file, "utf8"), file).not.toContain('"Access-Control-Allow-Origin": "*"');
    }
  });

  it("documents the unauthenticated dashboard without dead auth variables", () => {
    const text = `${read(".env.example")}\n${read("docs/ARCHITECTURE.md")}`;
    expect(text).not.toMatch(/JWT_SECRET|INITIAL_PASSWORD|AUTH_COOKIE_SECURE/);
    expect(text).toContain("dashboard has no authentication");
  });
});
