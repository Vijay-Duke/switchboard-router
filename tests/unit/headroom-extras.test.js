import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// child_process is mocked for the detect tests; rtk/headroom.js and the UI
// contract test do not shell out.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: mocks.execSync,
  execFileSync: mocks.execFileSync,
  spawn: vi.fn(),
}));

const { findPython310, getInstalledHeadroomExtras } = await import(
  "../../src/lib/headroom/detect.js"
);
const { formatHeadroomSizeLog } = await import("../../open-sse/rtk/headroom.js");

const ROOT = path.resolve(import.meta.dirname, "../..");
const tokenSaverSrc = fs.readFileSync(
  path.join(ROOT, "src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js"),
  "utf8"
);

beforeEach(() => {
  mocks.execSync.mockReset();
  mocks.execFileSync.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("headroom extras detection", () => {
  it("parses pip list JSON into installed version + marker-based extras", () => {
    mocks.execFileSync.mockReturnValue(
      JSON.stringify([
        { name: "headroom-ai", version: "0.26.0" },
        { name: "tree-sitter", version: "0.42.0" },
        { name: "Torch", version: "2.7.0" },
      ])
    );

    const status = getInstalledHeadroomExtras("python3");

    expect(status).toEqual({
      installed: true,
      version: "0.26.0",
      extras: { code: true, ml: true },
    });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "python3",
      ["-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
      expect.objectContaining({ timeout: 8000 })
    );
  });

  it("reports extras false when only the base package is present", () => {
    mocks.execFileSync.mockReturnValue(
      JSON.stringify([{ name: "headroom-ai", version: "0.25.2" }])
    );

    const status = getInstalledHeadroomExtras("python3");

    expect(status.installed).toBe(true);
    expect(status.version).toBe("0.25.2");
    expect(status.extras).toEqual({ code: false, ml: false });
  });

  it("returns a not-installed shape when headroom-ai is absent", () => {
    mocks.execFileSync.mockReturnValue(
      JSON.stringify([{ name: "pip", version: "24.0" }])
    );

    expect(getInstalledHeadroomExtras("python3")).toEqual({
      installed: false,
      version: null,
      extras: { code: false, ml: false },
    });
  });

  it("fails open to not-installed when pip itself errors", () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("pip exploded");
    });

    expect(getInstalledHeadroomExtras("python3")).toEqual({
      installed: false,
      version: null,
      extras: { code: false, ml: false },
    });
  });
});

describe("findPython310 interpreter preference", () => {
  it("prefers the interpreter beside the headroom binary that sees headroom-ai", () => {
    mocks.execSync.mockImplementation((cmd) => {
      if (cmd === "which headroom") return "/opt/headroom/bin/headroom";
      if (cmd.startsWith("/opt/headroom/bin/")) return "Python 3.11.9";
      throw new Error("not found");
    });
    // Only the binary-dir interpreter answers `pip show headroom-ai`.
    mocks.execFileSync.mockImplementation((py, args) => {
      if (py === "/opt/headroom/bin/python3") return "Name: headroom-ai";
      throw new Error("not found");
    });

    expect(findPython310()).toBe("/opt/headroom/bin/python3");
  });

  it("falls back to the first version-eligible interpreter when headroom-ai is nowhere", () => {
    mocks.execSync.mockImplementation((cmd) => {
      if (cmd === "which headroom") throw new Error("not found");
      if (cmd === "python3 --version") return "Python 3.13.1";
      if (cmd === "python --version") return "Python 3.9.7";
      throw new Error("not found");
    });
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(findPython310()).toBe("python3");
  });
});

describe("formatHeadroomSizeLog effective savings", () => {
  it("reports tools, tool history and effective payload reduction", () => {
    const line = formatHeadroomSizeLog({
      before: { bodyBytes: 1000, messageBytes: 800, toolSchemaBytes: 100, toolHistoryBytes: 500 },
      after: { bodyBytes: 900, messageBytes: 400, toolSchemaBytes: 100, toolHistoryBytes: 400 },
    });

    expect(line).toContain("body=1000B→900B");
    expect(line).toContain("tools=100B→100B");
    expect(line).toContain("toolHistory=500B→400B");
    expect(line).toContain("effective=10.0%");
  });

  it("renders 0.0% instead of NaN for zero-size bodies", () => {
    const line = formatHeadroomSizeLog({
      before: { bodyBytes: 0, messageBytes: 0, toolSchemaBytes: 0, toolHistoryBytes: 0 },
      after: { bodyBytes: 0, messageBytes: 0, toolSchemaBytes: 0, toolHistoryBytes: 0 },
    });

    expect(line).toContain("effective=0.0%");
    expect(line).not.toContain("NaN");
  });

  it("returns empty string without before/after snapshots", () => {
    expect(formatHeadroomSizeLog(null)).toBe("");
    expect(formatHeadroomSizeLog({})).toBe("");
  });
});

describe("token-saver headroom toggle UI contract", () => {
  it("reflects the enabled setting even when the proxy is down", () => {
    expect(tokenSaverSrc).toContain("checked={headroomEnabled}");
    expect(tokenSaverSrc).not.toContain("checked={headroomEnabled && headroomRunning}");
    // The stale toggle disabled itself while the proxy was down.
    expect(tokenSaverSrc).not.toMatch(/checked=\{headroomEnabled\}\s*\n\s*disabled=/);
  });

  it("restarts the proxy with persisted code-aware / kompress flags", () => {
    expect(tokenSaverSrc).toContain('"/api/headroom/restart"');
    expect(tokenSaverSrc).toContain('"headroomCodeAware"');
    expect(tokenSaverSrc).toContain('"headroomKompress"');
    expect(tokenSaverSrc).toContain("/api/headroom/extras?log=1");
  });
});
