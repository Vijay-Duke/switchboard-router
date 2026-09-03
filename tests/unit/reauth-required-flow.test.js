/**
 * T11 follow-ups: the reauth_required marker must (1) be produced by chatCore
 * when a refresh is unrecoverable, (2) survive updateProviderCredentials'
 * credential allowlist and the handler hooks that spread `testStatus:"active"`,
 * (3) survive the markAccountUnavailable call that follows the 401, and
 * (4) make getProviderCredentials skip the connection while a healthy sibling
 * exists — but still select it when it is the only one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  refreshCredentials: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: false,
    execute: mocks.execute,
    refreshCredentials: mocks.refreshCredentials,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...(await importOriginal()),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-reauth-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const REAUTH = "reauth_required";

async function seed(overrides = []) {
  const { createProviderConnection } = await import("../../src/lib/db/index.js");
  const ids = [];
  for (const [i, extra] of overrides.entries()) {
    const c = await createProviderConnection({
      provider: "gemini-cli",
      name: `acct-${i}`,
      authType: "oauth",
      accessToken: `at-${i}`,
      refreshToken: `rt-${i}`,
      priority: i + 1,
      isActive: true,
      ...extra,
    });
    ids.push(c.id);
  }
  return ids;
}

async function readConn(id) {
  const { getProviderConnections } = await import("../../src/lib/db/index.js");
  return (await getProviderConnections({ provider: "gemini-cli" })).find((c) => c.id === id);
}

describe("chatCore unrecoverable refresh branch", () => {
  it("emits the reauthRequired marker once and returns a reconnect error without retrying", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = (response) => ({ response, url: "https://cli-chat-proxy.grok.com/v1/responses", headers: {}, transformedBody: {} });
    mocks.execute.mockResolvedValue(result(new Response(JSON.stringify({ error: { message: "OAuth token invalid" } }), { status: 401 })));
    mocks.refreshCredentials.mockResolvedValue({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
    const onCredentialsRefreshed = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const out = await handleChatCore({
      body: { model: "grok-build", input: "hello", stream: false },
      modelInfo: { provider: "grok-cli", model: "grok-build" },
      credentials: { accessToken: "expired", refreshToken: "dead", providerSpecificData: {} },
      log,
      connectionId: "conn-dead",
      onCredentialsRefreshed,
      sourceFormatOverride: "openai-responses",
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: { endpoint: "/v1/responses", body: {}, headers: { accept: "application/json" } },
    });

    expect(mocks.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(onCredentialsRefreshed).toHaveBeenCalledTimes(1);
    expect(onCredentialsRefreshed).toHaveBeenCalledWith(expect.objectContaining({
      reauthRequired: true,
      testStatus: REAUTH,
      lastError: expect.stringMatching(/expired or revoked \(invalid_grant\).*reconnect/),
      lastErrorAt: expect.any(String),
    }));
    expect(out.success).toBe(false);
    expect(out.status).toBe(401);
    expect(out.error).toMatch(/reconnect/);
  });
});

describe("updateProviderCredentials status passthrough", () => {
  it("persists testStatus/lastError/lastErrorAt and lets reauthRequired override a hook's active", async () => {
    const [id] = await seed([{}]);
    const { updateProviderCredentials } = await import("../../src/sse/services/tokenRefresh.js");

    // Exact shape produced by the chat.js hook: chatCore payload spread, then testStatus:"active".
    await updateProviderCredentials(id, {
      reauthRequired: true,
      testStatus: REAUTH,
      lastError: "OAuth refresh token expired or revoked (invalid_grant): reconnect",
      lastErrorAt: "2026-09-03T00:00:00.000Z",
      existingProviderSpecificData: {},
      testStatus_ignored: "junk",
      apiKey: "sk-should-not-persist",
      testStatus: "active",
    });
    let conn = await readConn(id);
    expect(conn.testStatus).toBe(REAUTH);
    expect(conn.lastError).toMatch(/reconnect/);
    expect(conn.lastErrorAt).toBe("2026-09-03T00:00:00.000Z");
    expect(conn.apiKey).toBeUndefined();
    expect(conn.testStatus_ignored).toBeUndefined();
    expect(conn.accessToken).toBe("at-0");

    // A later successful refresh (user reconnected) clears the marker.
    await updateProviderCredentials(id, { accessToken: "at-new", refreshToken: "rt-new", testStatus: "active", lastError: null, lastErrorAt: null });
    conn = await readConn(id);
    expect(conn.testStatus).toBe("active");
    expect(conn.lastError).toBeNull();
    expect(conn.accessToken).toBe("at-new");
  });
});

describe("getProviderCredentials with reauth_required connections", () => {
  it("skips the reauth_required connection while a healthy sibling exists", async () => {
    const [dead, live] = await seed([{ testStatus: REAUTH, lastError: "reconnect" }, {}]);
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const sel = await getProviderCredentials("gemini-cli");
    expect(sel.connectionId).toBe(live);
    expect(sel.connectionId).not.toBe(dead);
  });

  it("still selects a reauth_required connection when it is the only eligible one", async () => {
    const [dead, live] = await seed([{ testStatus: REAUTH, lastError: "reconnect" }, {}]);
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const sel = await getProviderCredentials("gemini-cli", new Set([live]));
    expect(sel.connectionId).toBe(dead);
    expect(sel.testStatus).toBe(REAUTH);
  });

  it("markAccountUnavailable after the 401 keeps the marker and its reconnect message", async () => {
    const [dead] = await seed([{ testStatus: REAUTH, lastError: "OAuth refresh token expired or revoked (invalid_grant): reconnect" }]);
    const { markAccountUnavailable, getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const r = await markAccountUnavailable(dead, 401, "[401]: upstream says no", "gemini-cli", "gemini-2.5-pro");
    expect(r.shouldFallback).toBe(true);
    const conn = await readConn(dead);
    expect(conn.testStatus).toBe(REAUTH);
    expect(conn.lastError).toMatch(/reconnect/);
    expect(conn.errorCode).toBe(401);
    // Model lock now active on the only connection: surfaced lastError is the reconnect text.
    const sel = await getProviderCredentials("gemini-cli", null, "gemini-2.5-pro");
    expect(sel.allRateLimited).toBe(true);
    expect(sel.lastError).toMatch(/reconnect/);
  });
});
