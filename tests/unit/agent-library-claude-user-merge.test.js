// @ts-check
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mockState = vi.hoisted(() => ({ target: "", reads: 0 }));

// Monkeypatch readFile at the module registry so the merge code under test
// observes an external Claude Code session rewriting the file mid-merge.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  const readFile = async (...args) => {
    const out = await actual.readFile(...args);
    if (args[0] === mockState.target) {
      mockState.reads += 1;
      if (mockState.reads === 1) {
        const cur = JSON.parse(String(out));
        cur.projects = {
          ...(cur.projects || {}),
          "/tmp/external": { midMerge: true },
        };
        await actual.writeFile(args[0], JSON.stringify(cur, null, 2));
      }
    }
    return out;
  };
  return { ...actual, readFile, default: { ...actual, readFile } };
});

import { mergeJsonMcpConfig } from "@/lib/agent-library/mcp-adapters.js";

/** @type {string[]} */
const tempDirs = [];

afterEach(async () => {
  mockState.target = "";
  mockState.reads = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("claude-user merge into live ~/.claude.json", () => {
  it("re-reads and re-applies when the file moves mid-merge", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-claude-user-merge-"));
    tempDirs.push(dir);
    const file = path.join(dir, ".claude.json");
    await fs.writeFile(
      file,
      JSON.stringify({ projects: { "/tmp/p": {} }, mcpServers: {} }, null, 2),
      "utf-8"
    );

    mockState.target = file;
    const res = await mergeJsonMcpConfig(
      file,
      [
        {
          id: "sb-x",
          name: "X",
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
        },
      ],
      { kind: "claude-user", neverOverwriteUser: true, previouslyManaged: [] }
    );

    expect(res.ok).toBe(true);
    expect(res.written).toEqual(["sb-x"]);
    expect(mockState.reads).toBeGreaterThan(1); // retry path was exercised
    const final = JSON.parse(await fs.readFile(file, "utf-8"));
    expect(final.mcpServers["sb-x"].command).toBe("node");
    // The external key added mid-merge survives our write.
    expect(final.projects["/tmp/external"]).toEqual({ midMerge: true });
    expect(final.projects["/tmp/p"]).toEqual({});
  });

  it("preserves the file's existing tab indentation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-claude-user-indent-"));
    tempDirs.push(dir);
    const file = path.join(dir, ".claude.json");
    await fs.writeFile(
      file,
      JSON.stringify(
        { projects: { "/tmp/p": {} }, mcpServers: { other: { command: "x" } } },
        null,
        "\t"
      ),
      "utf-8"
    );

    const res = await mergeJsonMcpConfig(
      file,
      [
        {
          id: "sb-x",
          name: "X",
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
        },
      ],
      { kind: "claude-user", neverOverwriteUser: true, previouslyManaged: [] }
    );

    expect(res.ok).toBe(true);
    const raw = await fs.readFile(file, "utf-8");
    expect(raw).toContain('\n\t"mcpServers"');
    expect(raw).not.toMatch(/\n {2}"mcpServers"/);
  });
});
