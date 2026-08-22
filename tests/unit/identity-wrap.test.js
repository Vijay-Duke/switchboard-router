import { describe, it, expect, beforeEach } from "vitest";
import { stripLeaks, hasLeak } from "../../open-sse/identity/leaks.js";
import { wrapHeaders } from "../../open-sse/identity/wrap.js";
import { applyIdentity, resolveProfileId, orderHeaders } from "../../open-sse/identity/catalog.js";
import { harvest, getSnapshot, resetIdentityState, getDeviceProfile, pollIdentityVersions, setSnapshot } from "../../open-sse/identity/snapshot.js";
import { detectClientTool, harvestDetectedClient, isConfirmedClaudeClient } from "../../open-sse/utils/clientDetector.js";
import { mapStainlessOs, mapStainlessArch } from "../../open-sse/identity/os.js";

describe("stripLeaks", () => {
  it("drops Switchboard User-Agent and X-CLIENT-TYPE", () => {
    const out = stripLeaks({
      "User-Agent": "Switchboard/0.6.31",
      "X-CLIENT-TYPE": "switchboard",
      Authorization: "Bearer sk-ok",
    });
    expect(out["User-Agent"]).toBeUndefined();
    expect(out["X-CLIENT-TYPE"]).toBeUndefined();
    expect(out.Authorization).toBe("Bearer sk-ok");
    expect(hasLeak(out)).toBe(false);
  });

  it("drops X-Msh-Platform switchboard and OpenRouter title/url", () => {
    const out = stripLeaks({
      "X-Msh-Platform": "switchboard",
      "X-Title": "Switchboard",
      "HTTP-Referer": "https://github.com/Vijay-Duke/switchboard-router",
      "Content-Type": "application/json",
    });
    expect(out["X-Msh-Platform"]).toBeUndefined();
    expect(out["X-Title"]).toBeUndefined();
    expect(out["HTTP-Referer"]).toBeUndefined();
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("drops grok-cli/switchboard UA and x-switchboard-*", () => {
    const out = stripLeaks({
      "User-Agent": "grok-cli/switchboard",
      "x-switchboard-key": "sk_switchboard",
      Accept: "application/json",
    });
    expect(out["User-Agent"]).toBeUndefined();
    expect(out["x-switchboard-key"]).toBeUndefined();
    expect(out.Accept).toBe("application/json");
  });
});

describe("wrapHeaders", () => {
  it("replaces leaked UA with profile UA and keeps auth", () => {
    const { headers, profileId } = wrapHeaders(
      {
        Authorization: "Bearer tok",
        "User-Agent": "Switchboard/0.6.31",
        "X-CLIENT-TYPE": "switchboard",
      },
      { identity: "cline" },
    );
    expect(profileId).toBe("cline");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["User-Agent"]).toMatch(/^Cline\//);
    expect(headers["X-CLIENT-TYPE"]).toBe("extension");
    expect(hasLeak(headers)).toBe(false);
  });

  it("does not clobber Authorization with identity", () => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer secret", "Content-Type": "application/json" },
      { identity: "claude-cli" },
    );
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["User-Agent"]).toMatch(/^claude-cli\//);
    expect(headers["X-App"]).toBe("cli");
  });

  it("uses host OS/arch for claude, not hardcoded MacOS arm64", () => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer t" },
      { identity: "claude-cli" },
    );
    expect(headers["X-Stainless-Os"]).toBe(mapStainlessOs());
    expect(headers["X-Stainless-Arch"]).toBe(mapStainlessArch());
  });

  it("sets Helper-Method stream only when streaming", () => {
    const streamed = wrapHeaders({ Authorization: "Bearer t" }, { identity: "claude-cli", stream: true });
    expect(streamed.headers["X-Stainless-Helper-Method"]).toBe("stream");
    const json = wrapHeaders({ Authorization: "Bearer t" }, { identity: "claude-cli", stream: false });
    expect(json.headers["X-Stainless-Helper-Method"]).toBeUndefined();
  });

  it("increments Stainless retry count", () => {
    const first = wrapHeaders({ Authorization: "Bearer t" }, { identity: "claude-cli", retryCount: 0 });
    expect(first.headers["X-Stainless-Retry-Count"]).toBe("0");
    const retry = wrapHeaders({ Authorization: "Bearer t" }, { identity: "claude-cli", retryCount: 1 });
    expect(retry.headers["X-Stainless-Retry-Count"]).toBe("1");
  });

  it("does not let overlay reset the enforced retry count", () => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer t" },
      { identity: "claude-cli", retryCount: 1, overlay: { "x-stainless-retry-count": "0" } },
    );
    expect(headers["X-Stainless-Retry-Count"]).toBe("1");
    expect(headers["x-stainless-retry-count"]).toBeUndefined();
  });

  it("removes overlay stream helper on non-stream requests", () => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer t" },
      { identity: "claude-cli", stream: false, overlay: { "x-stainless-helper-method": "stream" } },
    );
    expect(headers["X-Stainless-Helper-Method"]).toBeUndefined();
    expect(headers["x-stainless-helper-method"]).toBeUndefined();
  });

  it("ignores a complete newer overlay tuple but keeps request identifiers", () => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer t" },
      {
        identity: "claude-cli",
        overlay: {
          "user-agent": "claude-cli/2.1.239 (external, cli)",
          "x-stainless-package-version": "0.99.0",
          "x-stainless-runtime-version": "v24.0.0",
          "anthropic-beta": "new-beta",
          "x-stainless-os": "MacOS",
          "x-stainless-arch": "arm64",
          "x-claude-code-session-id": "session-new",
          "x-client-request-id": "request-new",
        },
      },
    );
    expect(headers["User-Agent"]).toContain("claude-cli/2.1.220");
    expect(headers["X-Stainless-Package-Version"]).not.toBe("0.99.0");
    expect(headers["Anthropic-Beta"]).not.toBe("new-beta");
    expect(headers["x-claude-code-session-id"]).toBe("session-new");
    expect(headers["x-client-request-id"]).toBe("request-new");
  });

  it("throws when a caller supplies a Claude tuple inconsistent with TLS", () => {
    expect(() => wrapHeaders(
      { Authorization: "Bearer t" },
      {
        identity: "claude-cli",
        snapshot: {
          version: "2.1.239",
          billingVersion: "2.1.239",
          tlsSpecRev: "claude-code-2.1.220",
          userAgent: "claude-cli/2.1.239 (external, cli)",
          packageVersion: "0.99.0",
          runtimeVersion: "v24.0.0",
          betas: "new-beta",
        },
      },
    )).toThrow(/Claude identity mismatch/);
  });

  it("resolves openai-node for unknown openai-family providers", () => {
    expect(resolveProfileId(null, { format: "openai" })).toBe("openai-node");
    expect(resolveProfileId(null, { provider: "claude" })).toBe("claude-cli");
    expect(resolveProfileId("codex-cli")).toBe("codex-cli");
  });
});

describe("orderHeaders", () => {
  it("emits catalog order then leftovers", () => {
    const ordered = orderHeaders(
      { Z: "1", Accept: "a", Authorization: "b" },
      ["Authorization", "Accept"],
    );
    expect(Object.keys(ordered)).toEqual(["Authorization", "Accept", "Z"]);
  });
});

describe("harvest", () => {
  beforeEach(() => resetIdentityState());

  it("ignores partial claude harvest without Stainless", () => {
    expect(harvest("claude-cli", { "user-agent": "claude-cli/2.1.220 (external, cli)" })).toBe(false);
    expect(getSnapshot("claude-cli")?.version).toBe("2.1.220");
  });

  it("stores a complete claude tuple", () => {
    expect(harvest("claude-cli", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-runtime-version": "v22.19.0",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-os": "Linux",
      "x-stainless-arch": "x64",
    })).toBe(true);
    const snap = getSnapshot("claude-cli");
    expect(snap.version).toBe("2.1.220");
    expect(snap.packageVersion).toBe("0.94.0");
  });

  it("ignores complete-looking tuples without a Claude version", () => {
    expect(harvest("claude-cli", {
      "user-agent": "custom-client (external, cli)",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-runtime-version": "v22.19.0",
      "anthropic-beta": "oauth-2025-04-20",
    })).toBe(false);
    expect(getSnapshot("claude-cli")?.version).toBe("2.1.220");
  });

  it("never persists authentication headers", () => {
    expect(harvest("claude-cli", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-runtime-version": "v22.19.0",
      "anthropic-beta": "oauth-2025-04-20",
      authorization: "Bearer secret",
      "x-api-key": "secret-key",
    })).toBe(true);
    const serialized = JSON.stringify(getSnapshot("claude-cli"));
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("x-api-key");
  });

  it("harvests an exact fully confirmed 2.1.220 tuple into the snapshot", () => {
    const headers = {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-runtime-version": "v22.19.0",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-os": "Linux",
      "x-stainless-arch": "x64",
      "x-app": "cli",
    };
    const body = { metadata: { user_id: JSON.stringify({ session_id: "session-220" }) } };

    expect(isConfirmedClaudeClient(headers, body)).toBe(true);
    expect(getSnapshot("claude-cli")).toMatchObject({
      version: "2.1.220",
      packageVersion: "0.94.0",
      runtimeVersion: "v22.19.0",
    });
  });

  it("keeps harvested OS and arch stable after a later tuple", () => {
    expect(harvest("claude-cli", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-runtime-version": "v22.19.0",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-os": "Linux",
      "x-stainless-arch": "x64",
    })).toBe(true);
    expect(harvest("claude-cli", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "x-stainless-package-version": "0.94.1",
      "x-stainless-runtime-version": "v22.19.1",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-os": "MacOS",
      "x-stainless-arch": "arm64",
    })).toBe(true);
    expect(getSnapshot("claude-cli")).toMatchObject({ os: "Linux", arch: "x64" });
  });
});

describe("snapshot lifecycle", () => {
  beforeEach(() => {
    resetIdentityState();
    setSnapshot("claude-cli", {
      version: "2.1.220",
      billingVersion: "2.1.220",
      tlsSpecRev: "claude-code-2.1.220",
      latestVersion: "2.1.239",
      entrypoint: "cli",
      userAgent: "claude-cli/2.1.220 (external, cli)",
      packageVersion: "0.94.0",
      runtimeVersion: "v22.19.0",
      betas: "oauth-2025-04-20",
    });
  });

  it("records newer npm Claude metadata without upgrading the wire tuple", async () => {
    await pollIdentityVersions(async (url) => ({
      ok: true,
      json: async () => ({ version: url.includes("claude-code") ? "2.1.240" : "0.149.0" }),
    }));
    const snapshot = getSnapshot("claude-cli");
    expect(snapshot.version).toBe("2.1.220");
    expect(snapshot.billingVersion).toBe("2.1.220");
    expect(snapshot.latestVersion).toBe("2.1.240");
  });

  it("overrides frozen Claude registry identity with the live tuple", () => {
    const { headers } = wrapHeaders({
      Authorization: "Bearer token",
      "User-Agent": "claude-cli/2.1.92 (external, sdk-cli)",
    }, { identity: "claude-cli", credentialId: "credential-a" });

    expect(headers["User-Agent"]).toContain("claude-cli/2.1.220 (external, cli)");
    expect(headers["User-Agent"]).not.toContain("2.1.92");
    expect(headers["User-Agent"]).not.toContain("sdk-cli");
  });
});

describe("device profile", () => {
  beforeEach(() => resetIdentityState());

  it("is stable per credential", () => {
    const a = getDeviceProfile("acct-1");
    const b = getDeviceProfile("acct-1");
    const c = getDeviceProfile("acct-2");
    expect(a.buildHash).toBe(b.buildHash);
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.buildHash).not.toBe(c.buildHash);
    expect(a.buildHash).toMatch(/^[0-9a-f]{3}$/);
  });

  it("includes stable OS and arch per credential", () => {
    const a = getDeviceProfile("acct-1");
    const b = getDeviceProfile("acct-1");
    expect(a.os).toBe(b.os);
    expect(a.arch).toBe(b.arch);
    expect(a.os).toBe(mapStainlessOs());
    expect(a.arch).toBe(mapStainlessArch());
  });
});

describe("applyIdentity overlay", () => {
  it("ignores incomplete or mismatched Claude identity while preserving auth", () => {
    const merged = applyIdentity(
      { Authorization: "Bearer keep", "Content-Type": "application/json" },
      "claude-cli",
      { snapshot: getSnapshot("claude-cli"), overlay: { "user-agent": "claude-cli/9.9.9 (external, cli)", Authorization: "Bearer steal" } },
    );
    expect(merged.Authorization).toBe("Bearer keep");
    expect(merged["User-Agent"]).toContain("claude-cli/2.1.220");
  });

  it("deduplicates identity headers case-insensitively while caller auth wins", () => {
    const merged = applyIdentity(
      { authorization: "Bearer keep", "user-agent": "caller" },
      "claude-cli",
      { snapshot: getSnapshot("claude-cli"), overlay: { Authorization: "Bearer steal", "User-Agent": "claude-cli/9.9.9 (external, cli)" } },
    );
    const names = Object.keys(merged).map((name) => name.toLowerCase());
    expect(names.filter((name) => name === "authorization")).toHaveLength(1);
    expect(names.filter((name) => name === "user-agent")).toHaveLength(1);
    expect(merged.authorization).toBe("Bearer keep");
  });

  it("strips leaks introduced by a request overlay before output", () => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer keep" },
      { identity: "cline", overlay: { "X-Title": "Switchboard", "x-switchboard-test": "leak" } },
    );
    expect(hasLeak(headers)).toBe(false);
    expect(headers["X-Title"]).toBeUndefined();
    expect(headers["x-switchboard-test"]).toBeUndefined();
  });
});

describe("confirmed client harvest", () => {
  beforeEach(() => {
    resetIdentityState();
  });

  it.each([
    ["codex", { "user-agent": "codex_cli_rs/0.149.0" }, {}, "codex-cli"],
    ["gemini-cli", { "user-agent": "GeminiCLI/0.56.0/model (linux; x64; terminal)" }, {}, "gemini-cli"],
    ["cline", { "user-agent": "Cline/3.2.1", "x-client-type": "extension" }, {}, "cline"],
    ["qwen", { "user-agent": "QwenCode/0.12.3 (linux; x64)" }, {}, "qwen"],
    ["github-copilot", { "user-agent": "GitHubCopilotChat/0.38.0", "editor-version": "vscode/1.110.0", "editor-plugin-version": "copilot-chat/0.38.0", "x-github-api-version": "2025-04-01" }, {}, "copilot"],
  ])("harvests detected %s identity", (tool, headers, body, profileId) => {
    expect(detectClientTool(headers, body)).toBe(tool);
    expect(harvestDetectedClient(tool, headers, body)).toBe(true);
    expect(getSnapshot(profileId)?.version).toBeTruthy();
    if (profileId === "copilot") {
      expect(getSnapshot(profileId)).toMatchObject({
        chatVersion: "0.38.0",
        vscodeVersion: "1.110.0",
        apiVersion: "2025-04-01",
      });
    }
  });

  it("harvests Antigravity only when the body confirms it", () => {
    const headers = { "user-agent": "antigravity/1.107.0 darwin/arm64" };
    expect(detectClientTool(headers, {})).toBeNull();
    expect(detectClientTool(headers, { userAgent: "antigravity" })).toBe("antigravity");
    expect(harvestDetectedClient("antigravity", headers, { userAgent: "antigravity" })).toBe(true);
    expect(getSnapshot("antigravity")?.version).toBe("1.107.0");
  });

  it.each([
    ["UA only", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
    }, { metadata: { user_id: '{"session_id":"session-220"}' } }],
    ["missing x-app", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-runtime-version": "v22.19.0",
      "x-stainless-package-version": "0.94.0",
    }, { metadata: { user_id: '{"session_id":"session-220"}' } }],
    ["missing beta", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "x-app": "cli",
      "x-stainless-runtime-version": "v22.19.0",
      "x-stainless-package-version": "0.94.0",
    }, { metadata: { user_id: '{"session_id":"session-220"}' } }],
    ["missing metadata", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "x-app": "cli",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-runtime-version": "v22.19.0",
      "x-stainless-package-version": "0.94.0",
    }, {}],
    ["invalid metadata", {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "x-app": "cli",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-runtime-version": "v22.19.0",
      "x-stainless-package-version": "0.94.0",
    }, { metadata: { user_id: '{"session_id":""}' } }],
  ])("detects Claude routing but does not harvest an unconfirmed %s request", (_case, headers, body) => {
    expect(detectClientTool(headers, body)).toBe("claude");
    expect(harvestDetectedClient("claude", headers, body)).toBe(false);
    expect(isConfirmedClaudeClient(headers, body)).toBe(false);
  });
  it("accepts the existing Claude _session_ metadata form", () => {
    const headers = {
      "user-agent": "claude-code/2.1.220 (external, cli)",
      "x-app": "cli",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-runtime-version": "v22.19.0",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-os": "Linux",
      "x-stainless-arch": "x64",
    };
    const body = { metadata: { user_id: "user_session_01234567-89ab-cdef" } };
    expect(isConfirmedClaudeClient(headers, body)).toBe(true);
  });

  it("does not let a mismatched Claude version poison the current snapshot", () => {
    const confirmedHeaders = {
      "user-agent": "claude-cli/2.1.220 (external, cli)",
      "x-app": "cli",
      "anthropic-beta": "oauth-2025-04-20",
      "x-stainless-runtime-version": "v22.19.0",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-os": "Linux",
      "x-stainless-arch": "x64",
    };
    const body = { metadata: { user_id: '{"session_id":"poison-session"}' } };
    expect(detectClientTool(headers, body)).toBe("claude");
    expect(harvestDetectedClient("claude", headers, body)).toBe(false);
    expect(getSnapshot("claude-cli")).toMatchObject({
      version: "2.1.220",
      packageVersion: "0.94.0",
      runtimeVersion: "v22.19.0",
    });
  });

  it.each([
    [{ "user-agent": "Cline/3.2.1" }, {}],
    [{ "user-agent": "Mozilla/5.0 codex fan" }, {}],
    [{ "user-agent": "GitHubCopilotChat/0.38.0" }, {}],
    [{ "user-agent": "axios/1.7.0", "x-app": "cli" }, {}],
  ])("does not detect ambiguous identity", (headers, body) => {
    expect(detectClientTool(headers, body)).toBeNull();
  });
});

describe("registry identities", () => {
  it("assigns a resolvable sourced profile to every outbound transport", async () => {
    const [{ default: registry }, { PROFILES, resolveProfileId }] = await Promise.all([
      import("../../open-sse/providers/registry/index.js"),
      import("../../open-sse/identity/catalog.js"),
    ]);
    for (const entry of registry) {
      const transports = [entry.transport, ...(entry.transports || [])].filter(Boolean);
      const media = Object.entries(entry)
        .filter(([name, value]) => /Config$/.test(name) && value?.baseUrl)
        .map(([, value]) => value);
      for (const transport of [...transports, ...media]) {
        const profileId = resolveProfileId(transport.identity, { format: transport.format, provider: entry.id });
        expect(transport.identity, `${entry.id} transport identity`).toBeTruthy();
        expect(PROFILES[profileId], `${entry.id} profile`).toBeDefined();
        expect(PROFILES[profileId].source, `${entry.id} profile source`).toBeDefined();
      }
    }
  });

  it("documents a source for every catalog profile", async () => {
    const { PROFILES } = await import("../../open-sse/identity/catalog.js");
    for (const profile of Object.values(PROFILES)) {
      expect(profile.source, `${profile.id} source`).toBeDefined();
    }
  });
});
