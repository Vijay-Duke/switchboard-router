import os from "node:os";
import { beforeEach, describe, expect, it } from "vitest";

import { PROFILES } from "../../open-sse/identity/catalog.js";
import { hasLeak } from "../../open-sse/identity/leaks.js";
import { hostArch, hostPlatform } from "../../open-sse/identity/os.js";
import {
  getSnapshot,
  harvest,
  pollIdentityVersions,
  resetIdentityState,
  setSnapshot,
  snapshotBelongsToProfile,
} from "../../open-sse/identity/snapshot.js";
import { wrapHeaders } from "../../open-sse/identity/wrap.js";

const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

function userAgent(headers) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "user-agent");
  return key ? headers[key] : undefined;
}

describe("caller User-Agent vs identity profile (H32)", () => {
  it("keeps a deliberately set browser UA when no identity is requested (edge/google TTS hops)", () => {
    const { headers, profileId } = wrapHeaders({ "User-Agent": CHROME_UA, Accept: "*/*" }, {});
    expect(profileId).toBe("openai-node");
    expect(userAgent(headers)).toBe(CHROME_UA);
  });

  it("lets an explicit identity profile own the UA", () => {
    const { headers } = wrapHeaders({ "User-Agent": "custom/1.0", Authorization: "Bearer t" }, { identity: "cline" });
    expect(userAgent(headers)).toMatch(/^Cline\//);
  });

  it("always replaces a frozen Claude UA with the live tuple, even when defaulted by provider", () => {
    const { headers } = wrapHeaders(
      { "User-Agent": "claude-cli/2.1.92 (external, sdk-cli)", Authorization: "Bearer t" },
      { provider: "claude" },
    );
    expect(userAgent(headers)).toContain("claude-cli/2.1.258");
    expect(userAgent(headers)).not.toContain("2.1.92");
  });
});

describe("host-derived fingerprints (H33/H34)", () => {
  it("grok-build reports the host platform and arch, not a frozen linux/x86_64", () => {
    const { headers } = wrapHeaders({}, { identity: "grok-build" });
    const arch = { x64: "x86_64", arm64: "aarch64", ia32: "x86" }[hostArch()] || hostArch();
    expect(userAgent(headers)).toMatch(new RegExp(`^grok-shell/\\S+ \\(${hostPlatform()}; ${arch}\\)$`));
  });

  it("chrome profile UA carries the host platform token", () => {
    const { headers } = wrapHeaders({}, { identity: "chrome" });
    const expected = { darwin: "Macintosh", win32: "Windows NT", linux: "X11; Linux" }[hostPlatform()] || "X11; Linux";
    expect(userAgent(headers)).toContain(expected);
    expect(userAgent(headers)).toMatch(/Chrome\/\d+\.0\.0\.0/);
  });

  it("cline sends the OS release as X-PLATFORM-VERSION and gemini the runtime node version", () => {
    const cline = wrapHeaders({}, { identity: "cline", snapshot: { version: "3.0.0" } }).headers;
    expect(cline["X-PLATFORM-VERSION"]).toBe(os.release());
    expect(cline["X-PLATFORM-VERSION"]).not.toBe(process.version);

    const gemini = wrapHeaders({}, { identity: "gemini-cli", snapshot: { version: "0.56.0" } }).headers;
    expect(gemini["X-Goog-Api-Client"]).toContain(`gl-node/${process.version}`);
    expect(gemini["User-Agent"]).toContain(`(${hostPlatform()};`);
  });

  it("cursor hops no longer egress without a UA", () => {
    const { headers } = wrapHeaders({ Authorization: "Bearer t" }, { identity: "cursor" });
    expect(userAgent(headers)).toBeTruthy();
  });
});

describe("identity leak grep over every catalog profile", () => {
  it.each(Object.keys(PROFILES))("%s emits no product leak and preserves auth", (profileId) => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer keep", "X-Title": "Switchboard", "x-switchboard-key": "sk_switchboard" },
      { identity: profileId },
    );
    const serialized = JSON.stringify(headers);
    expect(headers.Authorization).toBe("Bearer keep");
    expect(hasLeak(headers)).toBe(false);
    expect(serialized).not.toMatch(/switchboard/i);
    expect(serialized).not.toMatch(/x-switchboard-/i);
    expect(serialized).not.toContain("github.com/Vijay-Duke");
    expect(userAgent(headers)).toBeTruthy();
  });
});

describe("identity poller cross-profile guard", () => {
  beforeEach(() => resetIdentityState());

  const registry = async (url) => ({
    ok: true,
    json: async () => ({
      version: url.includes("claude-code") ? "2.1.258" : url.includes("gemini-cli") ? "0.60.0" : "0.149.0",
    }),
  });

  it("rejects a snapshot whose UA belongs to another profile", () => {
    expect(snapshotBelongsToProfile("gemini-cli", { userAgent: "codex_cli_rs/0.149.0" })).toBe(false);
    expect(snapshotBelongsToProfile("gemini-cli", { userAgent: "GeminiCLI/0.56.0/m (linux; x64; terminal)" })).toBe(true);
    expect(snapshotBelongsToProfile("gemini-cli", { version: "0.56.0" })).toBe(true);
  });

  it("discards a stored gemini-cli version that is ahead of the registry (the codex 0.149.0 write)", async () => {
    setSnapshot("gemini-cli", { version: "0.149.0", checkedAt: 1 });
    await pollIdentityVersions(registry);
    expect(getSnapshot("gemini-cli").version).toBe("0.60.0");
  });

  it("discards a stored snapshot carrying a foreign UA", async () => {
    setSnapshot("gemini-cli", { version: "0.50.0", userAgent: "codex_cli_rs/0.149.0" });
    await pollIdentityVersions(registry);
    const snap = getSnapshot("gemini-cli");
    expect(snap.version).toBe("0.60.0");
    expect(snap.userAgent ?? "").not.toContain("codex_cli_rs");
  });

  it("still only moves a legitimate snapshot forward", async () => {
    setSnapshot("codex-cli", { version: "0.149.0", userAgent: "codex_cli_rs/0.149.0", checkedAt: 7 });
    await pollIdentityVersions(registry);
    expect(getSnapshot("codex-cli")).toMatchObject({ version: "0.149.0", checkedAt: 7 });
  });

  it("harvest refuses a UA from another profile", () => {
    expect(harvest("gemini-cli", { "user-agent": "codex_cli_rs/0.149.0" })).toBe(false);
    expect(getSnapshot("gemini-cli")?.userAgent ?? "").not.toContain("codex");
    expect(harvest("gemini-cli", { "user-agent": "GeminiCLI/0.57.0/m (linux; x64; terminal)" })).toBe(true);
    expect(getSnapshot("gemini-cli").version).toBe("0.57.0");
  });
});
