import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getGeneratedCapabilities,
  getGeneratedPricing,
  readCatalogFile,
} from "../../open-sse/providers/generated/loader.js";

function withTemporaryCatalog(content, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-catalog-"));
  const catalogPath = path.join(directory, "catalog.json");

  try {
    fs.writeFileSync(catalogPath, content, "utf8");
    callback(catalogPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

describe("generated catalog fail-open behavior", () => {
  it("returns an empty catalog when the file is unavailable", () => {
    expect(readCatalogFile("/no/such/path/catalog.json")).toEqual({
      pricing: {},
      capabilities: {},
    });
  });

  it("returns an empty catalog when the file contains invalid JSON", () => {
    withTemporaryCatalog("{ not json", (catalogPath) => {
      expect(readCatalogFile(catalogPath)).toEqual({ pricing: {}, capabilities: {} });
    });
  });

  it("preserves valid pricing while normalizing invalid capabilities", () => {
    withTemporaryCatalog('{"pricing":{"m":{"input":1}},"capabilities":null}', (catalogPath) => {
      expect(readCatalogFile(catalogPath)).toEqual({
        pricing: { m: { input: 1 } },
        capabilities: {},
      });
    });
  });

  it("returns null for missing model identifiers", () => {
    expect(getGeneratedPricing(null)).toBeNull();
    expect(getGeneratedCapabilities("")).toBeNull();
  });
});
