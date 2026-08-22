import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getComboModels: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: mocks.execute,
    refreshCredentials: vi.fn(async () => null),
    noAuth: false,
  })),
}));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.getComboModels,
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("@/sse/services/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));

const originalDataDir = process.env.DATA_DIR;
const originalRequestLogs = process.env.ENABLE_REQUEST_LOGS;
const originalCwd = process.cwd();
let tempDir;
let dbApi;
let adapter;
let handleChat;
let policy;
let requestDetails;
let consoleSpies;

function jsonProviderResponse() {
  return Response.json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
}

function sseProviderResponse({ close = true, onCancel = null } = {}) {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ id: "chatcmpl-stream", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-stream", object: "chat.completion.chunk", model: "test-model", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunks[0]));
      if (close) {
        controller.enqueue(encoder.encode(chunks[1]));
        controller.enqueue(encoder.encode(chunks[2]));
        controller.close();
      }
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function executorResult(response) {
  return { response, url: "https://provider.test/chat", headers: { authorization: "Bearer provider-secret" } };
}

function chatRequest(rawKey, { model = "deepseek/test-model", stream = false, signal } = {}) {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKey}`,
      "x-switchboard-key": rawKey,
      "x-api-key": rawKey,
      "x-goog-api-key": rawKey,
    },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hello" }] }),
    signal,
  });
}

function logBytes() {
  const root = path.join(tempDir, "logs");
  if (!fs.existsSync(root)) return "";
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push(file);
    }
  };
  visit(root);
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

async function assertSecretAbsent(secrets) {
  await requestDetails.flushPendingRequestDetails();
  const payload = {
    requestDetails: await dbApi.getRequestDetails(),
    history: await dbApi.getUsageHistory(),
    today: await dbApi.getUsageStats("today"),
    all: await dbApi.getUsageStats("all"),
    usageHistory: adapter.all("SELECT * FROM usageHistory"),
    usageDaily: adapter.all("SELECT * FROM usageDaily"),
    durableDetails: adapter.all("SELECT * FROM requestDetails"),
    logs: logBytes(),
    console: consoleSpies.flatMap((spy) => spy.mock.calls),
  };
  const serialized = JSON.stringify(payload);
  const dbDir = path.join(tempDir, "db");
  const sqliteBytes = fs.readdirSync(dbDir)
    .filter((name) => name === "data.sqlite" || name.startsWith("data.sqlite-"))
    .map((name) => fs.readFileSync(path.join(dbDir, name)))
    .reduce((joined, chunk) => Buffer.concat([joined, chunk]), Buffer.alloc(0));
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secret.slice(-12));
    expect(sqliteBytes.includes(Buffer.from(secret))).toBe(false);
    expect(sqliteBytes.includes(Buffer.from(secret.slice(-12)))).toBe(false);
  }
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-real-handler-security-"));
  process.env.DATA_DIR = tempDir;
  process.env.ENABLE_REQUEST_LOGS = "true";
  process.chdir(tempDir);
  delete global._dbAdapter;
  vi.resetModules();

  dbApi = await import("@/lib/db/index.js");
  await dbApi.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  await dbApi.updateSettings({ requireApiKey: true, rtkEnabled: false, enableObservability: true });
  await dbApi.updatePricing({ deepseek: { "test-model": { input: 1_000_000, output: 1_000_000 } } });
  requestDetails = await import("@/lib/db/repos/requestDetailsRepo.js");
  ({ handleChat } = await import("@/sse/handlers/chat.js"));
  policy = await import("@/sse/services/clientKeyPolicy.js");
}, 20_000);

beforeEach(() => {
  policy.__resetClientKeyPolicyStateForTests();
  adapter.run("DELETE FROM requestDetails");
  adapter.run("DELETE FROM usageDaily");
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM apiKeys");
  fs.rmSync(path.join(tempDir, "logs"), { recursive: true, force: true });
  vi.clearAllMocks();
  mocks.getComboModels.mockImplementation(async (model) => model === "combo-denied" ? ["deepseek/test-model"] : null);
  mocks.getModelInfo.mockResolvedValue({ provider: "deepseek", model: "test-model" });
  mocks.getProviderCredentials.mockResolvedValue({
    connectionId: "provider-connection",
    connectionName: "Provider connection",
    apiKey: "provider-secret",
    providerSpecificData: {},
  });
  consoleSpies = ["log", "warn", "error"].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
  consoleSpies.forEach((spy) => spy.mockRestore());
});

afterAll(async () => {
  try { await requestDetails?.flushPendingRequestDetails?.(); } catch {}
  try { await (await import("@/lib/db/driver.js")).closeAdapter(); } catch {}
  delete global._dbAdapter;
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalRequestLogs === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalRequestLogs;
});

async function createPolicyKey(patch = {}) {
  const key = await dbApi.createApiKey("Real handler", "6666666666666666");
  if (Object.keys(patch).length) await dbApi.updateApiKey(key.id, patch);
  return key;
}

describe("actual handler client-key boundaries", () => {
  it.each([
    ["non-stream", false],
    ["fully consumed SSE", true],
  ])("awaits %s completion spend before the next authorization", async (_name, stream) => {
    const key = await createPolicyKey({ spendLimitUsd: 1 });
    mocks.execute.mockResolvedValueOnce(executorResult(stream ? sseProviderResponse() : jsonProviderResponse()));

    const completed = await handleChat(chatRequest(key.key, { stream }));
    expect(completed.status).toBe(200);
    await completed.text();

    const rejected = await handleChat(chatRequest(key.key));
    expect(rejected.status).toBe(429);
    expect((await rejected.json()).error.code).toBe("client_key_spend_limit_exceeded");
    expect(await dbApi.getClientKeySpend(key.id)).toBeGreaterThanOrEqual(1);
    await assertSecretAbsent([key.key]);
  });

  it("releases a cancelled SSE lease and cancels its provider stream", async () => {
    const key = await createPolicyKey({ concurrencyLimit: 1 });
    const cancelled = vi.fn();
    mocks.execute
      .mockResolvedValueOnce(executorResult(sseProviderResponse({ close: false, onCancel: cancelled })))
      .mockResolvedValueOnce(executorResult(jsonProviderResponse()));

    const response = await handleChat(chatRequest(key.key, { stream: true }));
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel("client gone");
    expect(cancelled).toHaveBeenCalledOnce();

    const next = await handleChat(chatRequest(key.key));
    expect(next.status).toBe(200);
    await next.text();
    await assertSecretAbsent([key.key]);
  });

  it("keeps secrets absent across invalid, expired, allowlist, rate, concurrency, and spend rejections", async () => {
    const secrets = [];
    const invalid = (await import("@/shared/utils/apiKey.js")).generateApiKeyWithMachine("7777777777777777").key;
    secrets.push(invalid);
    expect((await handleChat(chatRequest(invalid))).status).toBe(401);

    const expired = await createPolicyKey({ expiresAt: "2026-08-21T00:00:00.000Z" });
    secrets.push(expired.key);
    expect((await handleChat(chatRequest(expired.key))).status).toBe(403);

    const modelDenied = await createPolicyKey({ allowedModels: ["deepseek/other"] });
    secrets.push(modelDenied.key);
    expect((await handleChat(chatRequest(modelDenied.key))).status).toBe(403);

    const comboDenied = await createPolicyKey({ allowedModels: ["deepseek/test-model"] });
    secrets.push(comboDenied.key);
    expect((await handleChat(chatRequest(comboDenied.key, { model: "combo-denied" }))).status).toBe(403);

    const rate = await createPolicyKey({ rateLimitPerMinute: 1 });
    secrets.push(rate.key);
    mocks.execute.mockResolvedValueOnce(executorResult(jsonProviderResponse()));
    expect((await handleChat(chatRequest(rate.key))).status).toBe(200);
    expect((await handleChat(chatRequest(rate.key))).status).toBe(429);

    const concurrency = await createPolicyKey({ concurrencyLimit: 1 });
    secrets.push(concurrency.key);
    mocks.execute.mockResolvedValueOnce(executorResult(sseProviderResponse()));
    const held = await handleChat(chatRequest(concurrency.key, { stream: true }));
    const concurrencyRejected = await handleChat(chatRequest(concurrency.key));
    expect(concurrencyRejected.status).toBe(429);
    expect((await concurrencyRejected.json()).error.code).toBe("client_key_concurrency_limit_exceeded");
    await held.text();

    const spend = await createPolicyKey({ spendLimitUsd: 0 });
    secrets.push(spend.key);
    const spendRejected = await handleChat(chatRequest(spend.key));
    expect(spendRejected.status).toBe(429);
    expect((await spendRejected.json()).error.code).toBe("client_key_spend_limit_exceeded");

    await assertSecretAbsent(secrets);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
