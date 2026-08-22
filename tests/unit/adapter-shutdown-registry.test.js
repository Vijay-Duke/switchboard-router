import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("SQLite adapter shutdown registry", () => {
  it("keeps one listener across module reloads and runs each active closer once", async () => {
    const listenerCountBefore = process.listenerCount("beforeExit");

    vi.resetModules();
    const first = await import("@/lib/db/adapters/adapterShutdownRegistry.js");
    vi.resetModules();
    const reloaded = await import("@/lib/db/adapters/adapterShutdownRegistry.js");

    const closers = Array.from({ length: 12 }, () => vi.fn());
    closers[5].mockImplementation(() => { throw new Error("close failed"); });
    const unregister = closers.map((closer, index) =>
      (index % 2 ? first : reloaded).registerAdapterCloser(closer));

    expect(process.listenerCount("beforeExit") - listenerCountBefore).toBeLessThanOrEqual(1);
    expect(unregister[0]()).toBe(true);
    expect(unregister[0]()).toBe(false);

    expect(() => process.emit("beforeExit", 0)).not.toThrow();
    expect(closers[0]).not.toHaveBeenCalled();
    for (const closer of closers.slice(1)) expect(closer).toHaveBeenCalledTimes(1);

    process.emit("beforeExit", 0);
    for (const closer of closers.slice(1)) expect(closer).toHaveBeenCalledTimes(1);
  });

  it("shares one listener across more than ten adapters and closes each exactly once", async () => {
    const listenersBefore = process.listeners("beforeExit");
    const { createNodeSqliteAdapter } = await import("@/lib/db/adapters/nodeSqliteAdapter.js");
    const adapters = [];
    const closeSpies = [];

    try {
      for (let index = 0; index < 12; index += 1) {
        const adapter = await createNodeSqliteAdapter(":memory:");
        adapters.push(adapter);
        closeSpies.push(vi.spyOn(adapter.raw, "close"));
      }

      expect(process.listenerCount("beforeExit") - listenersBefore.length).toBeLessThanOrEqual(1);

      adapters[0].close();
      adapters[0].close();
      process.emit("beforeExit", 0);
      process.emit("beforeExit", 0);

      for (const adapter of adapters) {
        adapter.close();
        adapter.close();
      }
      for (const closeSpy of closeSpies) expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      for (const adapter of adapters) adapter.close();
      for (const listener of process.listeners("beforeExit")) {
        if (!listenersBefore.includes(listener)) process.removeListener("beforeExit", listener);
      }
    }
  });

  it("unregisters repeated SQL.js close while preserving pending persistence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-sqljs-close-"));
    tempDirs.push(dir);
    const file = path.join(dir, "data.sqlite");
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const adapter = await createSqlJsAdapter(file);
    const closeSpy = vi.spyOn(adapter.raw, "close");

    adapter.exec("CREATE TABLE records (value TEXT)");
    adapter.run("INSERT INTO records (value) VALUES (?)", ["persisted"]);
    adapter.close();
    adapter.close();
    process.emit("beforeExit", 0);

    expect(closeSpy).toHaveBeenCalledTimes(1);

    const reopened = await createSqlJsAdapter(file);
    expect(reopened.get("SELECT value FROM records")).toEqual({ value: "persisted" });
    reopened.close();
  });
});
