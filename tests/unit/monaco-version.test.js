// The dashboard editor loads Monaco from a CDN, not node_modules (see
// src/shared/constants/monaco.js). Keep the pinned CDN version, the package.json
// range and the lockfile in step so a dependency bump changes what users run.
// (Adapted from upstream: checks package-lock.json rather than the installed
// copy, since test runs may share a node_modules that predates the bump.)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MONACO_VERSION, MONACO_VS_PATH } from "@/shared/constants/monaco.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const rootPkg = readJson("../../package.json");
const lock = readJson("../../package-lock.json");

describe("Monaco editor version pin", () => {
  it("matches the monaco-editor version declared and locked in the root package", () => {
    expect(rootPkg.dependencies["monaco-editor"]).toBe(`^${MONACO_VERSION}`);
    expect(lock.packages["node_modules/monaco-editor"].version).toBe(MONACO_VERSION);
  });

  it("loads that exact version's AMD build from jsdelivr", () => {
    expect(MONACO_VS_PATH).toBe(`https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`);
  });
});
