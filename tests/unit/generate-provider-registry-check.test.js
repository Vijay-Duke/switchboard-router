import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRegistryOutput,
  listRegistryFiles,
  main,
  registryUpToDate,
} from "../../scripts/generate-provider-registry.mjs";

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-registry-"));
  file = path.join(dir, "index.js");
  for (const name of ["beta.js", "alpha.js", "REGISTRY_TEMPLATE.js", "notes.md"]) {
    fs.writeFileSync(path.join(dir, name), "export default {};\n");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("generate-provider-registry --check (L3)", () => {
  it("lists provider files sorted, excluding index and template", () => {
    expect(listRegistryFiles(dir)).toEqual(["alpha.js", "beta.js"]);
  });

  it("treats a CRLF checkout of identical content as up to date", () => {
    const output = buildRegistryOutput(["alpha.js", "beta.js"]);
    expect(registryUpToDate(output.replace(/\n/g, "\r\n"), output)).toBe(true);
    expect(registryUpToDate(output, output)).toBe(true);
    expect(registryUpToDate(`${output}// edited\n`, output)).toBe(false);
  });

  it("--check passes on a CRLF index.js and fails on stale content", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const output = buildRegistryOutput(["alpha.js", "beta.js"]);
    fs.writeFileSync(file, output.replace(/\n/g, "\r\n"));
    expect(() => main(["--check"], { dir, file })).not.toThrow();
    expect(exit).not.toHaveBeenCalled();

    fs.writeFileSync(file, "// stale\n");
    expect(() => main(["--check"], { dir, file })).toThrow(/exit 1/);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/stale/));
  });

  it("writes the generated registry when not checking", () => {
    main([], { dir, file });
    expect(fs.readFileSync(file, "utf8")).toBe(buildRegistryOutput(["alpha.js", "beta.js"]));
  });
});
