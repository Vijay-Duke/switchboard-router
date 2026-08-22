import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";
import { packApiKeyRecord } from "@/lib/crypto/secrets.js";

const RAW_KEY = "sk-switchboard-usage-super-secret-tail";
const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({ getPricingForModel: vi.fn().mockResolvedValue(null) }));

let db;
let file;
let usage;

beforeAll(async () => {
  file = path.join(os.tmpdir(), `switchboard-client-key-usage-${crypto.randomUUID()}.sqlite`);
  db = await createNodeSqliteAdapter(file);
  for (const table of ["_meta", "apiKeys", "usageHistory", "usageDaily"]) {
    db.exec(buildCreateTableSql(table, TABLES[table]));
    for (const index of TABLES[table].indexes || []) db.exec(index);
  }
  mocks.getAdapter.mockResolvedValue(db);
  usage = await import("@/lib/db/repos/usageRepo.js");
});

beforeEach(() => {
  db.run(`DELETE FROM usageHistory`);
  db.run(`DELETE FROM usageDaily`);
  db.run(`DELETE FROM apiKeys`);
  db.run(`DELETE FROM _meta`);
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES ('client-1', ?, 'Build bot', 1, '2026-08-22T00:00:00.000Z')`,
    [packApiKeyRecord(RAW_KEY)]
  );
});

afterAll(() => {
  db?.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
});

function serializedBoundaries() {
  return JSON.stringify({
    historyRows: db.all(`SELECT * FROM usageHistory`),
    dailyRows: db.all(`SELECT * FROM usageDaily`),
  });
}

describe("client key usage attribution", () => {
  it("persists a stable key ID and never a reusable or masked gateway key", async () => {
    await usage.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-5",
      connectionId: "connection-1",
      clientKeyId: "client-1",
      apiKey: RAW_KEY,
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 2, completion_tokens: 3 },
      requestId: "request-1",
    });

    expect(db.all(`SELECT clientKeyId, requestId FROM usageHistory`)).toEqual([
      { clientKeyId: "client-1", requestId: "request-1" },
    ]);
    const daily = JSON.parse(db.get(`SELECT data FROM usageDaily`).data);
    expect(daily.byApiKey).toBeUndefined();
    expect(daily.byClientKey).toEqual({
      "client-1|gpt-5|openai": expect.objectContaining({
        clientKeyId: "client-1",
        rawModel: "gpt-5",
        provider: "openai",
        requests: 1,
      }),
    });
    expect(serializedBoundaries()).not.toContain(RAW_KEY);
    expect(serializedBoundaries()).not.toContain("apiKeyMasked");
  });

  it("returns ID/name-only attribution for history and today/all aggregates", async () => {
    const timestamp = new Date().toISOString();
    await usage.saveRequestUsage({
      timestamp,
      provider: "openai",
      model: "gpt-5",
      clientKeyId: "client-1",
      tokens: { prompt_tokens: 4, completion_tokens: 6 },
      requestId: "request-known",
    });
    await usage.saveRequestUsage({
      timestamp,
      provider: "anthropic",
      model: "claude-sonnet",
      clientKeyId: null,
      tokens: { input_tokens: 1, output_tokens: 2 },
      requestId: "request-local",
    });

    const history = await usage.getUsageHistory();
    expect(history).toEqual([
      expect.objectContaining({ clientKeyId: "client-1" }),
      expect.objectContaining({ clientKeyId: null }),
    ]);
    for (const period of ["today", "all"]) {
      const stats = await usage.getUsageStats(period);
      expect(Object.values(stats.byApiKey)).toEqual(expect.arrayContaining([
        expect.objectContaining({ clientKeyId: "client-1", keyName: "Build bot" }),
        expect.objectContaining({ clientKeyId: null, keyName: "Local (No API Key)" }),
      ]));
      const serialized = JSON.stringify(stats);
      expect(serialized).not.toContain(RAW_KEY);
      expect(serialized).not.toContain("apiKeyMasked");
      expect(serialized).not.toContain("apiKeyKey");
      expect(serialized).not.toContain("keyPrefix");
    }
  });

  it("keeps request identity de-duplication exact with client IDs", async () => {
    const entry = {
      timestamp: new Date().toISOString(), provider: "openai", model: "gpt-5",
      clientKeyId: "client-1", tokens: { prompt_tokens: 7, completion_tokens: 8 }, requestId: "same-request",
    };
    await usage.saveRequestUsage({ ...entry });
    await usage.saveRequestUsage({ ...entry });
    expect(db.get(`SELECT COUNT(*) count, SUM(promptTokens) prompt, SUM(completionTokens) completion FROM usageHistory`))
      .toEqual({ count: 1, prompt: 7, completion: 8 });
  });
});
