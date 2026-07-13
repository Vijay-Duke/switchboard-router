import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultConversationId } from "open-sse/routing/feedbackAsk.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let dbApi;
let driver;
let vault;
let vaultEngine;

function pointerId(text) {
  return text.match(/vlt_[a-f0-9]{12}/)?.[0] || "";
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-rtk-vault-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  dbApi = await import("@/lib/db/index.js");
  driver = await import("@/lib/db/driver.js");
  vault = await import("@/lib/db/repos/vaultRepo.js");
  vaultEngine = await import("open-sse/rtk/vault.js");
  const runtimeDeps = await import("open-sse/runtimeDeps.js");
  runtimeDeps.setOpenSseDeps({
    putVaultEntry: vault.putVaultEntry,
    getVaultEntry: vault.getVaultEntry,
    searchVault: vault.searchVault,
    cleanupExpiredVault: vault.cleanupExpiredVault,
  });
  await dbApi.initDb();
});

beforeEach(async () => {
  vault.resetVaultFtsProbe();
  const db = await driver.getAdapter();
  db.run("DELETE FROM vault_chunks");
  db.run("DELETE FROM vault_entries");
  try { db.run("DELETE FROM vault_fts"); } catch {}
});

afterAll(async () => {
  vault?.resetVaultFtsProbe();
  try { await driver?.closeAdapter?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("RTK vault", () => {
  it("stores oversized OpenAI tool results and replaces them with lossless pointers", async () => {
    const original = "x".repeat(20 * 1024);
    const body = { tools: [{ type: "function" }], messages: [{ role: "tool", content: original }] };

    const stats = await vaultEngine.storeToVault(body, {
      conversationId: "conversation-a", thresholdBytes: 8 * 1024, ttlMs: 60_000,
    });
    const id = pointerId(body.messages[0].content);

    expect(body.messages[0].content).toContain("[Switchboard vault]");
    expect(id).toMatch(/^vlt_/);
    expect(stats.vaulted).toBe(1);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    await expect(vault.getVaultEntry(id)).resolves.toMatchObject({ content: original });
  });

  it("leaves results below the threshold untouched", async () => {
    const original = "small ".repeat(350);
    const body = { messages: [{ role: "tool", content: original }] };
    const stats = await vaultEngine.storeToVault(body, {
      conversationId: "conversation-a", thresholdBytes: 8 * 1024, ttlMs: 60_000,
    });

    expect(stats.vaulted).toBe(0);
    expect(body.messages[0].content).toBe(original);
  });

  it("preserves error-shaped and explicitly errored tool results", async () => {
    const error = `Error: boom\n at x (y:1:1)\n${"trace\n".repeat(2_000)}`;
    const body = {
      messages: [
        { role: "tool", content: error },
        { role: "user", content: [{ type: "tool_result", is_error: true, content: "x".repeat(20 * 1024) }] },
      ],
    };
    const stats = await vaultEngine.storeToVault(body, {
      conversationId: "conversation-a", thresholdBytes: 8 * 1024, ttlMs: 60_000,
    });

    expect(stats.vaulted).toBe(0);
    expect(body.messages[0].content).toBe(error);
    expect(body.messages[1].content[0].content).toHaveLength(20 * 1024);
  });

  it("handles Claude tool_result string blocks", async () => {
    const original = "claude result ".repeat(2_000);
    const body = {
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: original }] }],
    };
    const stats = await vaultEngine.storeToVault(body, {
      conversationId: "conversation-a", thresholdBytes: 8 * 1024, ttlMs: 60_000,
    });
    const id = pointerId(body.messages[0].content[0].content);

    expect(stats.vaulted).toBe(1);
    await expect(vault.getVaultEntry(id)).resolves.toMatchObject({ content: original });
  });

  it("searches FTS entries within their conversation scope", async () => {
    const original = `${"reference material ".repeat(1_000)}the mitochondria is the powerhouse of the cell`;
    const body = { messages: [{ role: "tool", content: original }] };
    await vaultEngine.storeToVault(body, {
      conversationId: "conversation-a", thresholdBytes: 8 * 1024, ttlMs: 60_000,
    });

    await expect(vault.searchVault({ conversationId: "conversation-a", query: "powerhouse mitochondria", limit: 3 }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("powerhouse") })]));
    await expect(vault.searchVault({ conversationId: "conversation-b", query: "powerhouse mitochondria", limit: 3 }))
      .resolves.toEqual([]);
  });

  it("falls back to LIKE search when FTS is unavailable", async () => {
    const content = `${"reference material ".repeat(1_000)}the mitochondria is the powerhouse of the cell`;
    await vault.putVaultEntry({
      id: "like-entry", conversationId: "conversation-a", toolName: "read", content,
      chunks: vaultEngine.chunkContent(content), ttlMs: 60_000,
    });
    vault.__setFtsStateForTest(false);

    await expect(vault.searchVault({ conversationId: "conversation-a", query: "powerhouse mitochondria", limit: 3 }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("powerhouse") })]));
  });

  it("restricts search to the requested vault entry", async () => {
    const chunks = ["powerhouse alpha"];
    await vault.putVaultEntry({ id: "entry-a", conversationId: "conversation-a", content: chunks[0], chunks, ttlMs: 60_000 });
    await vault.putVaultEntry({ id: "entry-b", conversationId: "conversation-a", content: "powerhouse beta", chunks: ["powerhouse beta"], ttlMs: 60_000 });

    const result = await vault.searchVault({ conversationId: "conversation-a", query: "powerhouse", vaultId: "entry-a", limit: 5 });
    expect(result).toHaveLength(1);
    expect(result[0].entryId).toBe("entry-a");
  });

  it("chunks losslessly at safe paragraph boundaries", () => {
    const original = `${"a".repeat(3_900)}\n\n${"b".repeat(3_900)}\n\n${"c".repeat(3_900)}`;
    const chunks = vaultEngine.chunkContent(original);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks.join("")).toBe(original);

    const astral = `${"x".repeat(3_999)}😀${"y".repeat(20)}`;
    const astralChunks = vaultEngine.chunkContent(astral);
    expect(astralChunks.join("")).toBe(astral);
    expect(astralChunks.every((chunk) => !LONE_SURROGATE.test(chunk))).toBe(true);
  });

  it("stores and retrieves under one source-derived key, immune to translator id rewrites", async () => {
    const apiHash = "keyhash";
    const sourceMessages = [
      { role: "user", content: "analyze the logs" },
      { role: "assistant", content: "", tool_calls: [{ id: "client_call_1", function: { name: "read_logs", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "client_call_1", content: "big log output" },
    ];
    // A translator may normalize tool ids downstream; re-deriving the key from the
    // translated body would diverge — which is exactly why chatCore takes the key
    // from chat.js (source) instead of re-computing it.
    const translatedMessages = sourceMessages.map((m) =>
      m.tool_calls ? { ...m, tool_calls: [{ ...m.tool_calls[0], id: "provider_norm_1" }] }
        : (m.tool_call_id ? { ...m, tool_call_id: "provider_norm_1" } : m));
    expect(vaultConversationId(sourceMessages, apiHash)).not.toBe(vaultConversationId(translatedMessages, apiHash));

    // The pipeline derives once from source and reuses it for store + search.
    const key = vaultConversationId(sourceMessages, apiHash);
    await vault.putVaultEntry({
      id: "vlt_key", conversationId: key, toolName: "read_logs",
      content: "the answer is 42 hidden in the logs", chunks: ["the answer is 42 hidden in the logs"], ttlMs: 60_000,
    });
    await expect(vault.searchVault({ conversationId: key, query: "answer logs", limit: 3 }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("42") })]));
  });

  it("excludes expired entries from search on both FTS and LIKE paths", async () => {
    const content = `${"reference ".repeat(500)} the unique marker zebrafish`;
    await vault.putVaultEntry({
      id: "exp-1", conversationId: "conversation-a", toolName: "read",
      content, chunks: vaultEngine.chunkContent(content), ttlMs: 60_000,
    });
    // Live entry is findable.
    await expect(vault.searchVault({ conversationId: "conversation-a", query: "zebrafish marker", limit: 3 }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("zebrafish") })]));

    const db = await driver.getAdapter();
    db.run("UPDATE vault_entries SET expiresAt = ? WHERE id = ?", [new Date(Date.now() - 1).toISOString(), "exp-1"]);

    // Expired: gone from the FTS path even before the cleanup sweep runs.
    await expect(vault.searchVault({ conversationId: "conversation-a", query: "zebrafish marker", limit: 3 }))
      .resolves.toEqual([]);
    // Expired: gone from the durable LIKE fallback too.
    vault.__setFtsStateForTest(false);
    await expect(vault.searchVault({ conversationId: "conversation-a", query: "zebrafish marker", limit: 3 }))
      .resolves.toEqual([]);
  });

  it("floors the store threshold above the 6KB search-result cap", () => {
    // Keeps a capped sb_vault_search result (<=6KB) from ever re-vaulting.
    expect(vaultEngine.MIN_VAULT_THRESHOLD_KB).toBeGreaterThan(vaultEngine.SEARCH_RESULT_CAP_BYTES / 1024);
    expect(vaultEngine.clampVaultThresholdKB(3)).toBe(vaultEngine.MIN_VAULT_THRESHOLD_KB);
    expect(vaultEngine.clampVaultThresholdKB(8)).toBe(8);
    expect(vaultEngine.clampVaultThresholdKB(20)).toBe(20);
    expect(vaultEngine.clampVaultThresholdKB(undefined)).toBe(vaultEngine.MIN_VAULT_THRESHOLD_KB);
    expect(vaultEngine.clampVaultThresholdKB("not-a-number")).toBe(vaultEngine.MIN_VAULT_THRESHOLD_KB);
  });

  it("rejects invalid TTLs and cleans up expired entries", async () => {
    await expect(vault.putVaultEntry({
      id: "bad-ttl", conversationId: "conversation-a", content: "content", chunks: ["content"], ttlMs: -1,
    })).resolves.toBe(false);
    await vault.putVaultEntry({
      id: "expired", conversationId: "conversation-a", content: "content", chunks: ["content"], ttlMs: 60_000,
    });
    await expect(vault.cleanupExpiredVault()).resolves.toBe(0);

    const db = await driver.getAdapter();
    db.run("UPDATE vault_entries SET expiresAt = ? WHERE id = ?", [new Date(Date.now() - 1).toISOString(), "expired"]);
    await expect(vault.cleanupExpiredVault()).resolves.toBe(1);
    await expect(vault.getVaultEntry("expired")).resolves.toBeNull();
  });
});
