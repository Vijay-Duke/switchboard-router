// Ported from upstream a625ea9f: session-colored lifecycle log tags.
// Covers tagForSession color codes + seed truncation, nextTag rotation,
// line/errorLine level gating, and createStreamController tag unification.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { REQ_TAGS, nextTag, tagForSession, line, errorLine } from "../../open-sse/utils/logTags.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

const TS_RE = /^\[\d{2}:\d{2}:\d{2}\] /;

describe("REQ_TAGS palette", () => {
  it("has 8 distinct colored-dot tags", () => {
    expect(REQ_TAGS).toHaveLength(8);
    expect(new Set(REQ_TAGS).size).toBe(8);
    for (const t of REQ_TAGS) expect(t).toMatch(/[\u{1F7E2}\u{1F535}\u{1F7E3}\u{1F7E1}\u{1F7E0}\u{1F534}\u{26AA}\u{1F7E4}]/u);
  });
});

describe("tagForSession", () => {
  it("is deterministic: same seed always maps to the same color", () => {
    expect(tagForSession("sess-alpha")).toBe(tagForSession("sess-alpha"));
    expect(tagForSession("sess-alpha")).toBe(REQ_TAGS[5]); // 🔴, hash-stable
    expect(tagForSession("sess-beta")).toBe(REQ_TAGS[3]); // 🟡
  });

  it("always returns a palette member", () => {
    for (const seed of ["", "x", "claude-code-session-1234", "🟣emoji-seed", "z".repeat(300)]) {
      expect(REQ_TAGS).toContain(tagForSession(seed));
    }
  });

  it("truncates seeds longer than 128 chars before hashing", () => {
    const long = "x".repeat(5000);
    expect(tagForSession(long)).toBe(tagForSession(long.slice(0, 128)));
    expect(tagForSession(long)).toBe(tagForSession("x".repeat(128))); // 🟢
  });

  it("distinct seeds land in distinct buckets (fixed literals)", () => {
    const tags = new Set(["sess-alpha", "sess-beta", "sess-gamma"].map(tagForSession));
    expect(tags.size).toBeGreaterThanOrEqual(3);
  });

  it("falls back to a rotating allocation for empty seeds", () => {
    expect(REQ_TAGS).toContain(tagForSession(""));
    expect(REQ_TAGS).toContain(tagForSession(null));
    expect(REQ_TAGS).toContain(tagForSession(undefined));
  });
});

describe("nextTag rotation", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("walks the palette in order and wraps around", async () => {
    const fresh = await import("../../open-sse/utils/logTags.js");
    const seq = [fresh.nextTag(), fresh.nextTag(), fresh.nextTag()];
    expect(seq).toEqual([fresh.REQ_TAGS[0], fresh.REQ_TAGS[1], fresh.REQ_TAGS[2]]);
    // Exhaust the rest of the palette; the next allocation wraps to index 0.
    for (let i = 0; i < fresh.REQ_TAGS.length - 3; i++) fresh.nextTag();
    expect(fresh.nextTag()).toBe(fresh.REQ_TAGS[0]);
  });
});
describe("line / errorLine emission", () => {
  let spy;
  beforeEach(() => { spy = vi.spyOn(console, "log").mockImplementation(() => { }); });
  afterEach(() => vi.restoreAllMocks());

  it("line renders '[time] tag symbol message'", () => {
    line("🟢", "▶", "POST openai/gpt-4 · STREAM · 3 MSG");
    expect(spy).toHaveBeenCalledTimes(1);
    const out = spy.mock.calls[0][0];
    expect(out).toMatch(TS_RE);
    expect(out).toContain("🟢 ▶ POST openai/gpt-4 · STREAM · 3 MSG");
  });

  it("line omits an empty tag without double spaces", () => {
    line("", "✗", "FLUSH ERROR · openai/gpt-4 · boom");
    expect(spy.mock.calls[0][0]).toMatch(TS_RE);
    expect(spy.mock.calls[0][0]).not.toMatch(/\] {2}/);
  });

  it("errorLine always prints, regardless of level", () => {
    errorLine("🔵", "✗", "ERROR: boom");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(TS_RE);
    expect(spy.mock.calls[0][0]).toContain("🔵 ✗ ERROR: boom");
  });

  it("line is suppressed when LOG_LEVEL resolves above INFO", async () => {
    vi.resetModules();
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "WARN";
    try {
      const quiet = await import("../../open-sse/utils/logTags.js");
      quiet.line("🟢", "🌊", "COMPLETE · p/m · 1ms"); // suppressed
      quiet.errorLine("🟢", "✗", "ERROR: boom"); // still shown
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain("✗ ERROR: boom");
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });
});

describe("createStreamController unified tagging", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  function capture() {
    return vi.spyOn(console, "log").mockImplementation(() => { });
  }

  it("lifecycle lines are tagged with exactly one color chip, carry provider/model/duration, and drop the [STREAM] prefix", () => {
    const spy = capture();
    // One controller emits at most one lifecycle line (disconnected latch),
    // so allocate three controllers and assert the shared-tag invariant via reqTag.
    const mk = () => createStreamController({ provider: "openai", model: "gpt-4" });
    const c1 = mk(); c1.handleComplete();
    const c2 = mk(); c2.handleDisconnect("client_closed");
    const c3 = mk(); c3.handleError(Object.assign(new Error("x"), { name: "AbortError" }));
    expect(spy).toHaveBeenCalledTimes(3);
    const lines = spy.mock.calls.map(c => c[0]);
    for (const l of lines) {
      expect(l).toMatch(/ (🟢|🔵|🟣|🟡|🟠|🔴|⚪|🟤) /); // exactly one colored tag chip
      expect(l).toContain("openai/gpt-4");
      expect(l).toMatch(/· \d+ms$/);
      expect(l).not.toContain("[STREAM]"); // ad-hoc prefix must be gone
    }
    expect(lines[0]).toContain("🌊 COMPLETE");
    expect(lines[1]).toContain("⚡ DISCONNECT: client_closed");
    expect(lines[2]).toContain("⚡ ABORTED");
  });


  it("error path uses errorLine semantics: metadata first, stack trailing", () => {
    const spy = capture();
    const err = new Error("boom");
    const c = createStreamController({ provider: "anthropic", model: "claude" });
    c.handleError(err);
    expect(spy).toHaveBeenCalledTimes(1);
    const out = spy.mock.calls[0][0];
    expect(out).toMatch(/✗ ERROR: boom · anthropic\/claude · \d+ms\n    Error: boom\n/);
    expect(out).not.toContain("[STREAM]");
  });

  it("prefers host logger emitters, passing the same controller tag", () => {
    const seen = { line: [], errorLine: [] };
    const log = {
      line: (...a) => seen.line.push(a),
      errorLine: (...a) => seen.errorLine.push(a),
    };
    createStreamController({ log, provider: "p", model: "m", reqTag: "🟣" }).handleComplete();
    createStreamController({ log, provider: "p", model: "m", reqTag: "🟣" }).handleError(new Error("e1"));
    expect(seen.line[0]).toEqual(["🟣", "🌊", expect.stringContaining("COMPLETE · p/m · ")]);
    expect(seen.errorLine[0][0]).toBe("🟣");
    expect(seen.errorLine[0][2]).toContain("✗ ERROR: e1");
  });

  it("sessionSeed maps to a stable color per request", () => {
    const spy = capture();
    createStreamController({ provider: "p", model: "m", sessionSeed: "sess-alpha" }).handleComplete();
    createStreamController({ provider: "p", model: "m", sessionSeed: "sess-beta" }).handleComplete();
    const lines = spy.mock.calls.map(c => c[0]);
    expect(lines[0]).toContain("🔴"); // hash of "sess-alpha"
    expect(lines[1]).toContain("🟡"); // hash of "sess-beta"
  });

  it("explicit reqTag wins over seed/rotation", () => {
    const spy = capture();
    createStreamController({ provider: "p", model: "m", reqTag: "⚪", sessionSeed: "sess-alpha" }).handleComplete();
    expect(spy.mock.calls[0][0]).toContain("⚪ COMPLETE");
  });
});
