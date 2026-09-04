import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-config-allowlist-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("configImporter settings allowlist + import-once gate (L15)", () => {
  it("ignores unknown settings keys and applies known ones", async () => {
    const { importConfig } = await import("../../src/lib/configImporter.js");
    const { getSettings } = await import("../../src/lib/db/index.js");

    const stats = await importConfig({
      settings: { rtkEnabled: false, evilUnknownKey: "pwned", anotherOne: 123 },
    });
    expect(stats.settings).toBe(true);
    const settings = await getSettings();
    expect(settings.rtkEnabled).toBe(false);
    expect(settings.evilUnknownKey).toBeUndefined();
    expect(settings.anotherOne).toBeUndefined();
  });

  it("reports no settings change when only unknown keys are present", async () => {
    const { importConfig } = await import("../../src/lib/configImporter.js");
    const stats = await importConfig({ settings: { evilUnknownKey: "pwned" } });
    expect(stats.settings).toBe(false);
  });

  it("does not re-apply an unchanged file on second boot", async () => {
    const { autoImportConfigFile } = await import("../../src/lib/configImporter.js");
    const { getSettings, updateSettings } = await import("../../src/lib/db/index.js");

    fs.writeFileSync(
      path.join(tempDir, "config.yaml"),
      "settings:\n  ponytailEnabled: true\n"
    );

    const first = await autoImportConfigFile();
    expect(first?.settings).toBe(true);
    expect((await getSettings()).ponytailEnabled).toBe(true);

    // User changes the setting via the dashboard; a reboot must not clobber it.
    await updateSettings({ ponytailEnabled: false });
    const second = await autoImportConfigFile();
    expect(second).toBeNull();
    expect((await getSettings()).ponytailEnabled).toBe(false);
  });

  it("re-arms the import when the file content changes", async () => {
    const { autoImportConfigFile } = await import("../../src/lib/configImporter.js");
    const { getSettings } = await import("../../src/lib/db/index.js");

    const file = path.join(tempDir, "config.yaml");
    fs.writeFileSync(file, "settings:\n  ponytailEnabled: true\n");
    await autoImportConfigFile();
    expect((await getSettings()).ponytailEnabled).toBe(true);

    fs.writeFileSync(file, "settings:\n  ponytailEnabled: false\n");
    const stats = await autoImportConfigFile();
    expect(stats?.settings).toBe(true);
    expect((await getSettings()).ponytailEnabled).toBe(false);
  });
});
