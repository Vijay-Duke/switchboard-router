import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import { fileURLToPath } from "url";

const repoPath = (relativePath) =>
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));

// ============================================================
// AUDIT-002 (#1962): Non-secret client-key identity in usage stats
// ============================================================
describe("AUDIT-002: non-secret client-key identity", () => {
  it("usage source should not define raw-key masking", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    expect(source).not.toContain("function maskApiKey");
    expect(source).not.toContain("apiKeyMasked");
  });

  it("getUsageHistory should return durable client-key IDs only", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // History responses expose stable key identity, never raw key material
    const historyReturn = source.match(/return rows\.map\(\(r\)\s*=>\s*\(\{[\s\S]*?\}\)\);/);
    expect(historyReturn).not.toBeNull();
    expect(historyReturn[0]).toContain("clientKeyId: r.clientKeyId");
    expect(historyReturn[0]).not.toContain("apiKey: r.apiKey");
    expect(historyReturn[0]).not.toContain("apiKeyMasked");
  });

  it("getUsageStats should aggregate by client-key ID", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // Daily storage and rollups use durable client-key attribution
    expect(source).toContain("byClientKey");
    expect(source).toContain("Object.entries(day.byClientKey || {})");

    // The outward byApiKey compatibility view exposes key ID and name only
    const compatibilityEntries = source.match(
      /stats\.byApiKey\[clientKeyCounter\] = \{[\s\S]*?\n\s*\};/g
    );
    expect(compatibilityEntries).not.toBeNull();
    expect(compatibilityEntries.length).toBeGreaterThanOrEqual(2);
    for (const entry of compatibilityEntries) {
      expect(entry).toContain("clientKeyId");
      expect(entry).toContain("keyName");
      expect(entry).not.toMatch(/\bapiKey(?:Masked)?\s*:/);
    }
  });

  it("aggregate keys should use client-key IDs, never raw keys", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // Stored and live aggregate templates use clientKeyId
    expect(source).toContain(
      '${clientKeyId || "local-no-key"}|${entry.model}|${entry.provider || "unknown"}'
    );
    expect(source).toContain(
      '${clientKeyId || "local-no-key"}|${r.model}|${r.provider || "unknown"}'
    );
    expect(source).not.toContain("${r.apiKey}|${r.model}|${r.provider");
    expect(source).not.toContain("${apiKeyMasked}|${r.model}|${r.provider");
  });
});

// ============================================================
// AUDIT-003 (#1961): Proxy URL validation
// ============================================================
describe("AUDIT-003: Proxy URL validation", () => {
  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.SWITCHBOARD_PROXY_MANAGED;
    delete process.env.SWITCHBOARD_PROXY_URL;
    delete process.env.SWITCHBOARD_NO_PROXY;
    delete process.env.NO_PROXY;
  });

  it("source should contain validateProxyUrl function", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/network/outboundProxy.js"),
      "utf-8"
    );
    expect(source).toContain("function validateProxyUrl");
    expect(source).toContain("ALLOWED_PROXY_SCHEMES");
  });

  it("should accept valid http proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080",
    });
    // new URL().href normalizes (adds trailing slash)
    expect(process.env.HTTP_PROXY).toContain("http://proxy.example.com:8080");
    expect(process.env.HTTPS_PROXY).toContain("http://proxy.example.com:8080");
  });

  it("should accept valid https proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "https://proxy.example.com:443",
    });
    // new URL().href normalizes (drops default port 443, adds trailing slash)
    expect(process.env.HTTP_PROXY).toContain("https://proxy.example.com");
  });

  it("clears stale managed proxy variables when a replacement URL is invalid", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({ outboundProxyEnabled: true, outboundProxyUrl: "http://old.example:8080" });
    applyOutboundProxyEnv({ outboundProxyEnabled: true, outboundProxyUrl: "file:///etc/passwd" });

    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.ALL_PROXY).toBeUndefined();
    expect(process.env.SWITCHBOARD_PROXY_URL).toBeUndefined();
    expect(process.env.SWITCHBOARD_PROXY_MANAGED).toBeUndefined();
  });


  it("should accept valid socks5 proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "socks5://proxy.example.com:1080",
    });
    expect(process.env.ALL_PROXY).toBe("socks5://proxy.example.com:1080");
  });

  it("should reject URLs with shell metacharacters (newline)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080\nmalicious",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (backtick)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://`whoami`.example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (dollar)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://$(whoami).example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (file://)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "file:///etc/passwd",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (javascript:)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "javascript:alert(1)",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});

// ============================================================
// AUDIT-018 (#1972): XSS escaping in OAuth callback
// ============================================================
describe("AUDIT-018: XSS escaping in OAuth callback", () => {
  it("source should contain escapeHtml function", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("function escapeHtml");
  });

  it("should escape ampersand, angle brackets, and quotes", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("&amp;");
    expect(source).toContain("&lt;");
    expect(source).toContain("&gt;");
    expect(source).toContain("&quot;");
    expect(source).toContain("&#39;");
  });

  it("should use safeMessage in rendered HTML, not raw message", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("safeMessage");
    expect(source).toContain("${safeMessage}");
    // Should NOT use raw message in HTML body
    expect(source).not.toContain("<p>${message}</p>");
  });
});

// ============================================================
// AUDIT-004 (#1963): TOCTOU race - atomic lock file
// ============================================================
describe("AUDIT-004: Atomic lock file for MITM startup", () => {
  it("manager.js should define LOCK_FILE constant", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain("LOCK_FILE");
    expect(source).toContain(".mitm.lock");
  });

  it("should use O_EXCL flag (wx) for atomic creation", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain('"wx"');
    expect(source).toContain("EEXIST");
  });

  it("should clean up lock file on all exit paths", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );
    const matches = source.match(/unlinkSync\(LOCK_FILE\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// AUDIT-001 (#1965): Race condition in retry tracking
// ============================================================
describe("AUDIT-001: Synchronous restart guard", () => {
  it("mitmIsRestarting should be set before first await expression", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    expect(funcStart).toBeGreaterThan(-1);

    const funcBody = source.substring(funcStart, funcStart + 2000);

    const guardCheckIdx = funcBody.indexOf("if (mitmIsRestarting) return;");
    expect(guardCheckIdx).toBeGreaterThan(-1);

    const afterGuard = funcBody.substring(guardCheckIdx);

    // Strip line comments to avoid matching "await" in comment text
    const noComments = afterGuard.replace(/\/\/.*$/gm, "");

    // Find the first actual await expression
    const firstAwaitIdx = noComments.search(/\bawait\s+/);
    expect(firstAwaitIdx).toBeGreaterThan(-1);

    // Find mitmIsRestarting = true
    const setFlagIdx = noComments.indexOf("mitmIsRestarting = true");

    expect(setFlagIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(setFlagIdx).toBeLessThan(firstAwaitIdx);
  });

  it("mitmIsRestarting should be reset on max-restarts early return", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    const funcBody = source.substring(funcStart, funcStart + 2000);

    const maxRestartsIdx = funcBody.indexOf("Max restart attempts reached");
    expect(maxRestartsIdx).toBeGreaterThan(-1);

    const afterMax = funcBody.substring(maxRestartsIdx, maxRestartsIdx + 200);
    expect(afterMax).toContain("mitmIsRestarting = false");
  });
});
