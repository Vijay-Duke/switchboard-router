// @ts-check
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  existsSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";

import { atomicWriteFile, withAgentLibraryLock } from "@/lib/agent-library/fs-utils.js";
import {
  canManagePath,
  removeManagedMarker,
  writeManagedMarker,
} from "@/lib/agent-library/markers.js";
import { removePath, linkSkill } from "@/lib/agent-library/link.js";
import { applySync, runDoctor } from "@/lib/agent-library/sync.js";
import { defaultSettings } from "@/lib/agent-library/settings.js";

describe("agent-library residual hardening", () => {
  /** @type {string} */
  let tmp;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sb-al-hard-"));
  });

  afterAll(async () => {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("atomicWriteFile produces complete JSON", async () => {
    const f = path.join(tmp, "atomic.json");
    await atomicWriteFile(f, JSON.stringify({ ok: true, n: 42 }));
    expect(JSON.parse(readFileSync(f, "utf-8"))).toEqual({ ok: true, n: 42 });
  });

  it("removePath unlinks broken symlinks (existsSync would miss them)", async () => {
    const broken = path.join(tmp, "broken-link");
    symlinkSync(path.join(tmp, "no-such-target"), broken);
    expect(existsSync(broken)).toBe(false);
    expect(lstatSync(broken).isSymbolicLink()).toBe(true);
    await removePath(broken);
    expect(() => lstatSync(broken)).toThrow();
  });

  it("removeManagedMarker does not delete library files through skill symlink", async () => {
    const libSkill = path.join(tmp, "lib-skill");
    const agentDest = path.join(tmp, "agent-sb-demo");
    mkdirSync(libSkill, { recursive: true });
    writeFileSync(path.join(libSkill, "SKILL.md"), "---\nname: demo\n---\n# Demo\n");
    const libMarker = path.join(libSkill, ".switchboard-managed.json");
    writeFileSync(libMarker, JSON.stringify({ managedBy: "switchboard", planted: true }));
    symlinkSync(libSkill, agentDest);

    await removeManagedMarker(agentDest);

    expect(existsSync(libMarker)).toBe(true);
    expect(JSON.parse(readFileSync(libMarker, "utf-8")).planted).toBe(true);
  });

  it("canManagePath treats broken symlink as replaceable", async () => {
    const broken = path.join(tmp, "broken-gate");
    symlinkSync(path.join(tmp, "missing-xyz"), broken);
    const gate = await canManagePath(broken, true, {
      libraryRoot: path.join(tmp, "library"),
    });
    expect(gate.ok).toBe(true);
    expect(gate.reason).toBe("broken_symlink");
  });

  it("withAgentLibraryLock serializes concurrent work", async () => {
    /** @type {string[]} */
    const order = [];
    const p1 = withAgentLibraryLock(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 60));
      order.push("a-end");
      return 1;
    });
    const p2 = withAgentLibraryLock(async () => {
      order.push("b-start");
      order.push("b-end");
      return 2;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("linkSkill refuses to overwrite user-owned path when neverOverwriteUser", async () => {
    const src = path.join(tmp, "src-skill");
    const dest = path.join(tmp, "user-owned-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, "SKILL.md"), "---\nname: x\n---\n# X\n");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "USER.md"), "mine");

    await expect(
      linkSkill(src, dest, "copy", path.join(tmp, "library"), {
        neverOverwriteUser: true,
      })
    ).rejects.toMatchObject({ code: "conflict" });

    expect(existsSync(path.join(dest, "USER.md"))).toBe(true);
  });

  it("writeManagedMarker uses sidecar and never writes through symlink", async () => {
    const libSkill = path.join(tmp, "lib-skill-2");
    const dest = path.join(tmp, "symlink-dest");
    mkdirSync(libSkill, { recursive: true });
    writeFileSync(path.join(libSkill, "SKILL.md"), "# s\n");
    if (existsSync(dest)) await removePath(dest);
    symlinkSync(libSkill, dest);

    await writeManagedMarker(dest, {
      skillId: "demo",
      libraryPath: libSkill,
      linkMode: "symlink",
    });

    const sidecar = path.join(tmp, ".sb-managed-symlink-dest.json");
    expect(existsSync(sidecar)).toBe(true);
    // Must not plant internal marker inside library via symlink
    expect(existsSync(path.join(libSkill, ".switchboard-managed.json"))).toBe(false);
  });

  it("applySync dry-run returns ok without exclusive lock contention", async () => {
    const settings = defaultSettings();
    const dry = await applySync(settings, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
  });

  it("runDoctor returns a report object", async () => {
    const settings = defaultSettings();
    const doc = await runDoctor(settings);
    expect(typeof doc.ok).toBe("boolean");
    expect(Array.isArray(doc.issues)).toBe(true);
    expect(Array.isArray(doc.checks)).toBe(true);
  });
});
