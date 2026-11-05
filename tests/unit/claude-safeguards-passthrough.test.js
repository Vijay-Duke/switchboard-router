/**
 * Auto-mode server-side classifier pass-through (Claude Code gateway guide):
 * Claude Code pairs a `safeguards` request body field with a value in the
 * `anthropic-beta` header and reads `safeguard_results` back from the
 * response. A gateway that replaces the client's beta header with its own
 * fixed list, forwards `safeguards` to non-Anthropic upstreams, or drops
 * response keys/events makes the session ineligible for no-charge
 * server-side checks and Claude Code falls back to billed classifier calls.
 * See https://code.claude.com/docs/en/auto-mode-classifier-billing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrapHeaders } from "../../open-sse/identity/wrap.js";

// A capability beta only the client knows about. The gateway must forward
// such values verbatim instead of allowlisting the ones it observed.
const CLIENT_ONLY_BETA = "safeguards-2099-01-01";

function betaList(headers) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "anthropic-beta");
  return key ? String(headers[key]).split(",").map((s) => s.trim()).filter(Boolean) : [];
}

describe("anthropic-beta forwarding for Claude hops", () => {
  it("unions a newer client's betas into the outbound header instead of dropping them", () => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer [REDACTED]" },
      {
        identity: "claude-cli",
        overlay: {
          // Complete tuple, but a different Claude Code version than the
          // harvested snapshot — the normal case after a client update.
          "user-agent": "claude-cli/9.9.9 (external, cli)",
          "x-stainless-package-version": "0.99.0",
          "x-stainless-runtime-version": "v24.0.0",
          "anthropic-beta": `claude-code-20250219,${CLIENT_ONLY_BETA}`,
          "x-stainless-os": "MacOS",
          "x-stainless-arch": "arm64",
        },
      },
    );
    const betas = betaList(headers);
    expect(betas).toContain(CLIENT_ONLY_BETA);
    // Snapshot/profile betas are still present (union, not replacement).
    expect(betas).toContain("interleaved-thinking-2025-05-14");
    // Version-bearing fingerprint headers still come from the snapshot.
    expect(headers["User-Agent"]).not.toContain("9.9.9");
    expect(headers["X-Stainless-Package-Version"]).not.toBe("0.99.0");
  });

  it("does not forward betas from a non-Claude overlay", () => {
    const { headers } = wrapHeaders(
      { Authorization: "Bearer [REDACTED]" },
      {
        identity: "claude-cli",
        overlay: {
          "user-agent": "some-other-sdk/1.0",
          "anthropic-beta": CLIENT_ONLY_BETA,
        },
      },
    );
    expect(betaList(headers)).not.toContain(CLIENT_ONLY_BETA);
  });
});

describe("safeguards body field gating by upstream", () => {
  let DefaultExecutor;
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  const body = () => ({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    safeguards: { opaque: "client-value" },
  });

  it("keeps safeguards for the official Claude provider", () => {
    const executor = new DefaultExecutor("claude");
    const out = executor.transformRequest("claude-sonnet-5", body(), true, { accessToken: "t" });
    expect(out.safeguards).toEqual({ opaque: "client-value" });
  });

  it("keeps safeguards for an anthropic-compatible node on api.anthropic.com", () => {
    const executor = new DefaultExecutor("anthropic-compatible-test");
    const out = executor.transformRequest("claude-sonnet-5", body(), true, {
      apiKey: "k",
      providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" },
    });
    expect(out.safeguards).toEqual({ opaque: "client-value" });
  });

  it("strips safeguards for a third-party anthropic-compatible upstream", () => {
    const executor = new DefaultExecutor("anthropic-compatible-test");
    const out = executor.transformRequest("claude-sonnet-5", body(), true, {
      apiKey: "k",
      providerSpecificData: { baseUrl: "https://third-party.example/v1" },
    });
    expect(out.safeguards).toBeUndefined();
  });
});

describe("passthrough SSE events", () => {
  it("forwards unknown events and keeps the event line when a chunk is re-serialized", async () => {
    const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const toolNameMap = new Map([["Bash_cc", "Bash"]]);
    const stream = createPassthroughStreamWithLogger("claude", null, toolNameMap, "claude-sonnet-5", null, null, null, null);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const enc = new TextEncoder();
    const frames = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5","stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n`,
      // Decloaked tool name forces re-serialization of this frame.
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash_cc","input":{}}}\n\n`,
      // Unknown-to-the-gateway event carrying classifier verdicts.
      `event: safeguard_results\ndata: {"type":"safeguard_results","safeguard_results":[{"tool_use_id":"toolu_1","verdict":"allow"}]}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const writeAll = (async () => {
      for (const f of frames) await writer.write(enc.encode(f));
      // message_stop terminates the readable side, which closes the writer.
      await writer.close().catch(() => {});
    })();
    let out = "";
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    await writeAll;
    expect(out).toContain("event: content_block_start");
    expect(out).toContain(`"name":"Bash"`);
    expect(out).toContain("event: safeguard_results");
    expect(out).toContain(`"tool_use_id":"toolu_1"`);
    // Tool-use IDs are never rewritten.
    expect(out).toContain(`"id":"toolu_1"`);
  });
});
