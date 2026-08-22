import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let dbApi;
let adapter;
let requestDetails;
let created;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-client-key-security-"));
  process.env.DATA_DIR = tempDir;
  process.env.OBSERVABILITY_ENABLED = "true";
  delete global._dbAdapter;
  vi.resetModules();
  dbApi = await import("@/lib/db/index.js");
  await dbApi.initDb();
  const driver = await import("@/lib/db/driver.js");
  adapter = await driver.getAdapter();
  requestDetails = await import("@/lib/db/repos/requestDetailsRepo.js");
  created = await dbApi.createApiKey("Security regression", "machine-security");
});

afterAll(async () => {
  try { await requestDetails?.flushPendingRequestDetails?.(); } catch {}
  try { await (await import("@/lib/db/driver.js")).closeAdapter(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete process.env.OBSERVABILITY_ENABLED;
});

describe("gateway key telemetry boundary", () => {
  it("keeps the reusable secret out of SQLite, details, history, and aggregate metrics", async () => {
    const rawKey = created.key;
    const secretTail = rawKey.slice(-12);
    await dbApi.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-5",
      clientKeyId: created.id,
      apiKey: rawKey,
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 3, completion_tokens: 4 },
      requestId: "security-request",
    });
    await requestDetails.saveRequestDetail({
      id: "security-detail",
      provider: "openai",
      model: "gpt-5",
      request: {
        headers: {
          authorization: `Bearer ${rawKey}`,
          "x-switchboard-key": rawKey,
          "x-api-key": rawKey,
          "x-goog-api-key": rawKey,
          accept: "application/json",
        },
      },
      response: { ok: true },
      status: "success",
    });
    await requestDetails.flushPendingRequestDetails();

    const history = await dbApi.getUsageHistory();
    const today = await dbApi.getUsageStats("today");
    const all = await dbApi.getUsageStats("all");
    const details = await dbApi.getRequestDetails();
    const durable = {
      historyRows: adapter.all(`SELECT * FROM usageHistory`),
      dailyRows: adapter.all(`SELECT * FROM usageDaily`),
      detailRows: adapter.all(`SELECT * FROM requestDetails`),
      history,
      today,
      all,
      details,
    };
    const serialized = JSON.stringify(durable);
    expect(serialized).not.toContain(rawKey);
    expect(serialized).not.toContain(secretTail);
    expect(serialized).not.toContain("apiKeyMasked");
    expect(serialized).not.toContain("apiKeyKey");
    expect(JSON.stringify(today.byApiKey)).not.toContain("keyPrefix");
    expect(history[0]).toEqual(expect.objectContaining({ clientKeyId: created.id }));
    expect(details.details[0].request.headers).toEqual({ accept: "application/json" });

    await (await import("@/lib/db/driver.js")).closeAdapter();
    const dbDir = path.join(tempDir, "db");
    const bytes = fs.readdirSync(dbDir)
      .filter((name) => name === "data.sqlite" || name.startsWith("data.sqlite-"))
      .map((name) => fs.readFileSync(path.join(dbDir, name)))
      .reduce((joined, chunk) => Buffer.concat([joined, chunk]), Buffer.alloc(0));
    expect(bytes.includes(Buffer.from(rawKey))).toBe(false);
    expect(bytes.includes(Buffer.from(secretTail))).toBe(false);
  });
});
