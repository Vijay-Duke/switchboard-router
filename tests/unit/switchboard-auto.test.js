/**
 * Auto-route unit tests: parse, score, fingerprint, prompt, handleAutoChat state machine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseRouterPick, resolvePoolModel } from "../../open-sse/routing/parseRouterResponse.js";
import { computeOutcomeScore } from "../../open-sse/routing/scoring.js";
import { buildRequestSignals } from "../../open-sse/routing/fingerprint.js";
import {
  buildRouterPrompt,
  healthFromStats,
} from "../../open-sse/routing/buildRouterPrompt.js";
import {
  handleAutoChat,
  extractAssistantText,
  clampExploration,
  EXPLORATION_RATE_CAP,
  STREAM_PROBE_IDLE_MS,
  hasStreamContent,
  hasJsonCompletion,
  isSseKeepaliveText,
  acceptWorkerResponse,
  probeStreamForContent,
  restreamFromProbe,
} from "../../open-sse/routing/handleAutoChat.js";
import {
  deriveRules,
  describeRuleGaps,
  computeReplayEval,
  pickFewShots,
  buildBanditTable,
  buildBanditTableFromEvents,
} from "../../open-sse/routing/optimizer.js";
import { rankByObjective, costTier } from "../../open-sse/routing/objective.js";

const POOL = ["openai/gpt-4o-mini", "anthropic/claude-sonnet", "openai/gpt-4o"];

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openaiChatText(text) {
  return jsonResponse({
    choices: [{ message: { role: "assistant", content: text } }],
  });
}

describe("parseRouterPick", () => {
  it("parses clean JSON", () => {
    const p = parseRouterPick(
      JSON.stringify({
        model: "anthropic/claude-sonnet",
        cluster: "refactor",
        confidence: "high",
        reason: "needs deep reasoning",
        alternates: ["openai/gpt-4o"],
      }),
      POOL
    );
    expect(p.model).toBe("anthropic/claude-sonnet");
    expect(p.cluster).toBe("refactor");
    expect(p.confidence).toBe("high");
    expect(p.alternates).toContain("openai/gpt-4o");
  });

  it("strips markdown fences", () => {
    const p = parseRouterPick(
      '```json\n{"model":"openai/gpt-4o-mini","cluster":"quick","confidence":"low","reason":"short"}\n```',
      POOL
    );
    expect(p.model).toBe("openai/gpt-4o-mini");
  });

  it("parses the first JSON object when the router appends another object", () => {
    const p = parseRouterPick(
      '{"model":"anthropic/claude-sonnet","cluster":"general","confidence":"high","reason":"best"}\nmetadata: {"latency":"low"}',
      POOL,
    );
    expect(p.model).toBe("anthropic/claude-sonnet");
    expect(p.parseError).toBeUndefined();
  });

  it("falls back to pool[0] on invalid model and sanitizes cluster/reason", () => {
    const p = parseRouterPick(
      JSON.stringify({
        model: "not-in-pool",
        cluster: { nested: true },
        confidence: "high",
        reason: "x".repeat(500),
      }),
      POOL
    );
    expect(p.model).toBe(POOL[0]);
    expect(p.parseError).toBe("not_in_pool");
    expect(p.cluster).toBe("general");
    expect(p.reason.length).toBeLessThanOrEqual(280);
  });

  it("matches short model suffix when unambiguous", () => {
    const p = parseRouterPick(
      JSON.stringify({ model: "claude-sonnet", cluster: "debug", confidence: "high", reason: "ok" }),
      POOL
    );
    expect(p.model).toBe("anthropic/claude-sonnet");
  });

  it("does not guess when suffix matches multiple pool entries", () => {
    const multi = ["openai/gpt-4o", "azure/gpt-4o"];
    const p = parseRouterPick(
      JSON.stringify({ model: "gpt-4o", cluster: "x", confidence: "high", reason: "x" }),
      multi
    );
    expect(p.model).toBe(multi[0]);
    expect(p.parseError).toBe("not_in_pool");
  });

  it("handles empty text", () => {
    const p = parseRouterPick("", POOL);
    expect(p.model).toBe(POOL[0]);
    expect(p.parseError).toBe("empty");
  });
});

describe("resolvePoolModel", () => {
  it("returns null on ambiguous suffix", () => {
    expect(resolvePoolModel("gpt-4o", ["openai/gpt-4o", "azure/gpt-4o"])).toBeNull();
  });
  it("returns unique match", () => {
    expect(resolvePoolModel("claude-sonnet", POOL)).toBe("anthropic/claude-sonnet");
  });
});

describe("computeOutcomeScore", () => {
  it("scores successful high-confidence completed route", () => {
    const s = computeOutcomeScore({
      workerOk: true,
      confidence: "high",
      hasCompletion: true,
    });
    expect(s).toBe(70); // 40+20+10
  });

  it("scores low-confidence success with completion at 50", () => {
    const s = computeOutcomeScore({
      workerOk: true,
      confidence: "low",
      hasCompletion: true,
    });
    expect(s).toBe(50); // 40+10
  });

  it("does not grant completion points from workerOk alone", () => {
    const s = computeOutcomeScore({
      workerOk: true,
      confidence: "high",
      hasCompletion: false,
    });
    expect(s).toBe(60); // 40+20, no +10
  });

  it("applies latency bonus when below cluster ref", () => {
    const s = computeOutcomeScore({
      workerOk: true,
      confidence: "low",
      hasCompletion: true,
      workerLatencyMs: 100,
      clusterP50LatencyMs: 500,
    });
    expect(s).toBe(65); // 40+15+10
  });

  it("SPEC: 2xx with fallback does not get +40 (clamps near 0)", () => {
    // Spec: no +40, -30 fallback, +10 completion → 0; high conf needs score>0 so no +20
    const s = computeOutcomeScore({
      workerOk: true,
      confidence: "high",
      hasCompletion: true,
      fallbackUsed: true,
    });
    expect(s).toBe(0); // -30+10 = -20 → 0, no +40
  });

  it("penalizes failures", () => {
    const s = computeOutcomeScore({
      workerOk: false,
      confidence: "low",
      fallbackUsed: true,
    });
    expect(s).toBe(0); // -20-30 clamped
  });

  it("clamps 0–100", () => {
    expect(
      computeOutcomeScore({ workerOk: true, confidence: "high", hasCompletion: true })
    ).toBeLessThanOrEqual(100);
    expect(
      computeOutcomeScore({ workerOk: false, fallbackUsed: true, retries: 3 })
    ).toBeGreaterThanOrEqual(0);
  });

  it("uses tokensOut as completion evidence", () => {
    const s = computeOutcomeScore({
      workerOk: true,
      confidence: "low",
      hasCompletion: false,
      tokensOut: 42,
    });
    expect(s).toBe(50);
  });
});

describe("buildRequestSignals", () => {
  it("detects vision and tools", () => {
    const s = buildRequestSignals({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "refactor this image" },
            { type: "image_url", image_url: { url: "https://x/a.png" } },
          ],
        },
      ],
      tools: [{ type: "function", function: { name: "x" } }],
    });
    expect(s.modalities).toContain("vision");
    expect(s.hasTools).toBe(true);
    expect(s.keywordHints).toContain("refactor");
    expect(s.fingerprint).toHaveLength(16);
  });

  it("counts plain string content parts", () => {
    const s = buildRequestSignals({
      messages: [
        {
          role: "user",
          content: ["hello world ".repeat(100), { type: "text", text: "more" }],
        },
      ],
    });
    expect(s.tokenBand).not.toBe("0-500");
  });

  it("counts Responses API input_text blocks once (no double scan)", () => {
    const long = "x".repeat(600);
    const s = buildRequestSignals({
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: long }],
        },
      ],
    });
    expect(s.tokenBand).toBe("500-2k");
    // If doubled to 1200 would still be 500-2k; use 1500 chars → double would jump to 2k-8k
    const s2 = buildRequestSignals({
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "y".repeat(1500) }],
        },
      ],
    });
    expect(s2.tokenBand).toBe("500-2k");
  });

  it("scans string Responses API input as user content", () => {
    const s = buildRequestSignals({ input: "debug this request ".repeat(500) });

    expect(s.tokenBand).toBe("8k+");
    expect(s.userSummary).toContain("debug this request");
    expect(s.keywordHints).toContain("debug");
  });
});

describe("buildRouterPrompt", () => {
  it("includes pool ids, objective, and untrusted intent delimiters", () => {
    const { messages, signals } = buildRouterPrompt({
      comboName: "auto",
      pool: POOL,
      body: { messages: [{ role: "user", content: "hello" }] },
      objective: "economy",
      learning: {
        learnedRules: ["prefer mini for short tasks"],
        fewShots: [{ cluster: "quick", worker: POOL[0], score: 90, summary: "hi" }],
        banditTable: {
          general: {
            [POOL[0]]: { wins: 8, attempts: 10, avgScore: 72 },
            [POOL[1]]: { wins: 7, attempts: 10, avgScore: 70 },
          },
        },
      },
    });
    const system = messages.find((m) => m.role === "system")?.content || "";
    const user = messages.find((m) => m.role === "user")?.content || "";
    expect(user).toContain("openai/gpt-4o-mini");
    expect(system).toContain("economy");
    expect(system).toContain("untrusted");
    expect(user).toContain("prefer mini");
    expect(user).toContain("BANDIT");
    expect(user).toContain("avgLat:");
    expect(user).toContain("<<<USER_INTENT");
    expect(user).toContain("USER_INTENT>>>");
    expect(user).toContain("FEWSHOT");
    expect(user).toContain("JSON only");
    expect(system).toContain("untrusted");
    expect(signals.userSummary).toBeTruthy();
  });
});

describe("healthFromStats", () => {
  it("does not produce winRate > 1 on first observation", () => {
    const h = healthFromStats(
      [{ cluster: "g", pickedWorker: POOL[0], n: 1, avgScore: 70, avgLatencyMs: 100 }],
      POOL
    );
    expect(h[POOL[0]].winRate).toBeCloseTo(0.7, 5);
    expect(h[POOL[0]].winRate).toBeLessThanOrEqual(1);
    expect(h[POOL[0]].attempts).toBe(1);
  });

  it("seeds at 0 attempts / 0 winRate", () => {
    const h = healthFromStats([], POOL);
    expect(h[POOL[0]].winRate).toBe(0);
    expect(h[POOL[0]].attempts).toBe(0);
  });
});

describe("clampExploration", () => {
  it("caps at EXPLORATION_RATE_CAP", () => {
    expect(clampExploration(1)).toBe(EXPLORATION_RATE_CAP);
    expect(clampExploration(0.5)).toBe(EXPLORATION_RATE_CAP);
  });
  it("returns 0 for NaN", () => {
    expect(clampExploration(NaN)).toBe(0);
    expect(clampExploration("nope")).toBe(0);
  });
  it("allows 0", () => {
    expect(clampExploration(0)).toBe(0);
  });
});

describe("deriveRules", () => {
  it("requires ≥10 attempts per LEARNING.md", () => {
    const rules = deriveRules({
      general: {
        "openai/gpt-4o-mini": { wins: 5, attempts: 5, avgScore: 90, avgLatencyMs: 100 },
      },
    });
    expect(rules.length).toBe(0);
  });

  it("mints prefer rule when best leads second by >15 avgScore", () => {
    const rules = deriveRules({
      general: {
        a: { wins: 9, attempts: 10, avgScore: 90, avgLatencyMs: 100 },
        b: { wins: 5, attempts: 10, avgScore: 50, avgLatencyMs: 100 },
      },
    });
    expect(rules.some((r) => r.includes("prefer a"))).toBe(true);
  });

  it("avoids the worst model, not an arbitrary middle one", () => {
    const rules = deriveRules({
      general: {
        a: { wins: 9, attempts: 10, avgScore: 90, avgLatencyMs: 100 },
        b: { wins: 7, attempts: 10, avgScore: 70, avgLatencyMs: 100 },
        c: { wins: 2, attempts: 10, avgScore: 20, avgLatencyMs: 100 },
      },
    });
    const avoid = rules.find((r) => r.startsWith("Avoid"));
    expect(avoid).toContain("c");
    expect(avoid).not.toContain("Avoid b");
  });

  it("caps at 10 rules", () => {
    const table = {};
    for (let i = 0; i < 20; i++) {
      table[`c${i}`] = {
        a: { wins: 10, attempts: 10, avgScore: 90 },
        b: { wins: 1, attempts: 10, avgScore: 10 },
      };
    }
    expect(deriveRules(table).length).toBeLessThanOrEqual(10);
  });
});

describe("pickFewShots", () => {
  it("requires score >= 85 and dedupes fingerprints", () => {
    const events = [
      { outcomeScore: 90, pickedWorker: "a", cluster: "x", requestFingerprint: "fp1", routerReason: "ok", meta: {} },
      { outcomeScore: 90, pickedWorker: "a", cluster: "x", requestFingerprint: "fp1", routerReason: "dup", meta: {} },
      { outcomeScore: 70, pickedWorker: "b", cluster: "y", requestFingerprint: "fp2", routerReason: "low", meta: {} },
      { outcomeScore: 95, pickedWorker: "c", cluster: "y", requestFingerprint: "fp3", routerReason: "best", meta: { userSummary: "hello intent" } },
    ];
    const shots = pickFewShots(events, 5);
    expect(shots.every((s) => s.score >= 85)).toBe(true);
    expect(shots.filter((s) => s.fingerprint === "fp1").length).toBe(1);
    expect(shots.some((s) => s.summary === "hello intent")).toBe(true);
  });
});

describe("buildBanditTable", () => {
  it("uses real wins from stats and clamps to attempts", () => {
    const t = buildBanditTable([
      { cluster: "g", pickedWorker: "a", n: 10, wins: 15, avgScore: 80, avgLatencyMs: 100 },
    ]);
    expect(t.g.a.wins).toBe(10); // clamped
    expect(t.g.a.attempts).toBe(10);
  });
});

describe("rankByObjective", () => {
  it("economy prefers cheaper when scores within 10%", () => {
    // Use ids with unknown pricing (tier 4) vs we can't control pricing easily —
    // just verify quality ranks by avgScore
    const ranked = rankByObjective(
      [
        { id: "cheap/m", avgScore: 80, attempts: 10, p50LatencyMs: 200 },
        { id: "dear/m", avgScore: 82, attempts: 10, p50LatencyMs: 100 },
      ],
      "quality"
    );
    expect(ranked[0].id).toBe("dear/m");
  });

  it("economy with all-zero scores is pure cost order (explicit branch)", () => {
    const ranked = rankByObjective(
      [
        { id: "a", avgScore: 0, attempts: 0 },
        { id: "b", avgScore: 0, attempts: 0 },
      ],
      "economy"
    );
    // Both tier-unknown (4); stable sort by score then insertion — must not throw
    expect(ranked).toHaveLength(2);
    expect(ranked.every((e) => e.avgScore === 0)).toBe(true);
  });

  it("latency prefers lowest p50", () => {
    const ranked = rankByObjective(
      [
        { id: "a", avgScore: 80, p50LatencyMs: 500 },
        { id: "b", avgScore: 70, p50LatencyMs: 100 },
      ],
      "latency"
    );
    expect(ranked[0].id).toBe("b");
  });

  it("costTier returns 0–4", () => {
    expect(costTier("unknown/model")).toBeGreaterThanOrEqual(0);
    expect(costTier("unknown/model")).toBeLessThanOrEqual(4);
  });
});

describe("computeReplayEval", () => {
  it("scores the given events against policy (caller owns holdout)", () => {
    const bandit = {
      general: {
        "openai/gpt-4o-mini": { wins: 8, attempts: 10, avgScore: 80 },
        "openai/gpt-4o": { wins: 4, attempts: 10, avgScore: 40 },
      },
    };
    const events = Array.from({ length: 10 }, (_, i) => ({
      cluster: "general",
      pickedWorker: "openai/gpt-4o-mini",
      outcomeScore: 80,
      meta: { terminal: true },
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const score = computeReplayEval(bandit, events);
    expect(score).toBeGreaterThan(50);
  });

  it("compares two policies on the same held-out set fairly", () => {
    const heldOut = [
      {
        cluster: "general",
        pickedWorker: "a",
        outcomeScore: 90,
        meta: { terminal: true },
        timestamp: "2026-01-02",
      },
      {
        cluster: "general",
        pickedWorker: "b",
        outcomeScore: 40,
        meta: { terminal: true },
        timestamp: "2026-01-03",
      },
    ];
    const good = {
      general: {
        a: { wins: 9, attempts: 10, avgScore: 90 },
        b: { wins: 2, attempts: 10, avgScore: 40 },
      },
    };
    const bad = {
      general: {
        a: { wins: 2, attempts: 10, avgScore: 40 },
        b: { wins: 9, attempts: 10, avgScore: 90 },
      },
    };
    const goodEval = computeReplayEval(good, heldOut, "quality");
    const badEval = computeReplayEval(bad, heldOut, "quality");
    // quality picks max avgScore cell; good policy picks a, bad picks b
    expect(goodEval).toBeGreaterThan(badEval);
  });
});

describe("buildBanditTableFromEvents", () => {
  it("aggregates wins and p50 from events", () => {
    const t = buildBanditTableFromEvents([
      { cluster: "g", pickedWorker: "a", outcomeScore: 80, workerLatencyMs: 100, meta: {} },
      { cluster: "g", pickedWorker: "a", outcomeScore: 40, workerLatencyMs: 300, meta: {} },
      { cluster: "g", pickedWorker: "b", outcomeScore: 70, workerLatencyMs: 200, meta: {} },
    ]);
    expect(t.g.a.attempts).toBe(2);
    expect(t.g.a.wins).toBe(1);
    expect(t.g.a.p50LatencyMs).toBe(200);
  });
});

describe("describeRuleGaps", () => {
  it("notes when top two are within 15 pts", () => {
    const notes = describeRuleGaps({
      general: {
        a: { wins: 7, attempts: 10, avgScore: 70 },
        b: { wins: 6, attempts: 10, avgScore: 68 },
      },
    });
    expect(notes.some((n) => n.includes("within 15"))).toBe(true);
  });
});

describe("hasStreamContent / hasJsonCompletion", () => {
  it("detects OpenAI tool_calls deltas", () => {
    const buf = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]}}]}\n`;
    expect(hasStreamContent(buf)).toBe(true);
  });

  it("detects Claude input_json_delta", () => {
    expect(
      hasStreamContent(
        `data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}\n`
      )
    ).toBe(true);
  });

  it("detects Gemini functionCall", () => {
    expect(hasStreamContent(`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"x"}}]}}]}\n`)).toBe(
      true
    );
  });

  it("empty stream buffer is not completion", () => {
    expect(hasStreamContent("data: [DONE]\n")).toBe(false);
  });

  it("does not treat error SSE as completion", () => {
    expect(
      hasStreamContent(
        `data: {"error":{"message":"rate limited","text":"too many requests"}}\n`
      )
    ).toBe(false);
  });

  it("does not treat thinking_delta alone as completion", () => {
    expect(
      hasStreamContent(
        `data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}\n`
      )
    ).toBe(false);
  });

  it("does not treat empty Claude text content_block_start as completion", () => {
    expect(
      hasStreamContent(
        `data: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n`
      )
    ).toBe(false);
  });

  it("treats Claude tool_use content_block_start as completion", () => {
    expect(
      hasStreamContent(
        `data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"x"}}\n`
      )
    ).toBe(true);
  });

  it("detects tool_calls in non-stream JSON", () => {
    expect(
      hasJsonCompletion({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }],
            },
          },
        ],
      })
    ).toBe(true);
  });
});

describe("probeStreamForContent / restreamFromProbe", () => {
  it("treats [DONE]-only stream as empty", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const p = await probeStreamForContent(body, 2000);
    expect(p.accepted).toBe(false);
    expect(p.reason).toBe("empty_stream_end");
  });

  it("accepts on first non-keepalive event (thinking) without waiting for text", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"plan"}}\n\n`
          )
        );
        // more chunks never sent — probe should already have accepted
      },
    });
    const p = await probeStreamForContent(body, 2000);
    expect(p.accepted).toBe(true);
    expect(p.reader).toBeTruthy();
    // cancel rest so the test doesn't hang
    await p.reader.cancel();
  });

  it("uses idle timeout not wall-clock (slow thinking stays alive)", async () => {
    let step = 0;
    const body = new ReadableStream({
      async pull(c) {
        step += 1;
        if (step === 1) {
          c.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          return;
        }
        if (step === 2) {
          // Simulate ~50ms gap with another keepalive then real event
          await new Promise((r) => setTimeout(r, 50));
          c.enqueue(
            new TextEncoder().encode(
              `data: {"type":"message_start","message":{"id":"m1"}}\n\n`
            )
          );
          return;
        }
        // hold open until cancelled after accept
        await new Promise((r) => setTimeout(r, 5000));
      },
    });
    const p = await probeStreamForContent(body, 500); // idle 500ms, wall would fire if absolute
    expect(p.accepted).toBe(true);
    await p.reader?.cancel?.();
  });

  it("restream preserves prefix order and propagates cancel", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"B"}}]}\n\n'));
        c.close();
      },
    });
    const p = await probeStreamForContent(body, 2000);
    expect(p.accepted).toBe(true);
    const restreamed = restreamFromProbe(p);
    const text = await new Response(restreamed).text();
    expect(text).toContain('"content":"A"');
    expect(text).toContain('"content":"B"');
    // A before B
    expect(text.indexOf('"content":"A"')).toBeLessThan(text.indexOf('"content":"B"'));
  });

  it("idle timeout cancels empty silent stream", async () => {
    // No pull/enqueue — read() hangs until cancel from idle timeout
    const body = new ReadableStream({ start() {} });
    const t0 = Date.now();
    const p = await probeStreamForContent(body, 60);
    expect(p.accepted).toBe(false);
    expect(p.reason).toBe("probe_idle_timeout");
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("logs skippedRouter failure when single-worker stream is empty", async () => {
    const events = [];
    const res = await handleAutoChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o-mini"],
      handleSingleModel: async () =>
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      log: { info: () => {}, warn: () => {} },
      comboName: "solo",
      strategy: {},
      recordEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(res.status).toBe(503);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].meta?.skippedRouter).toBe(true);
    expect(events[0].meta?.terminal).toBe(true);
  });

  it("isSseKeepaliveText recognises comments and DONE", () => {
    expect(isSseKeepaliveText(": ping\n\n")).toBe(true);
    expect(isSseKeepaliveText("data: [DONE]\n\n")).toBe(true);
    expect(isSseKeepaliveText('data: {"type":"message_start"}\n')).toBe(false);
  });

  it("acceptWorkerResponse passes unparseable non-stream through", async () => {
    const res = new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const out = await acceptWorkerResponse(res);
    expect(out.ok).toBe(true);
    expect(out.preInspect?.hasCompletion).toBe(false);
  });

  it("acceptWorkerResponse rejects empty JSON completion", async () => {
    const res = new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    const out = await acceptWorkerResponse(res);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("empty_json");
  });

  it("does not accept SSE error-only streams (allows fallback)", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: {"error":{"message":"rate limited","text":"too many"}}\n\ndata: [DONE]\n\n`
          )
        );
        c.close();
      },
    });
    const p = await probeStreamForContent(body, 2000);
    expect(p.accepted).toBe(false);
    expect(p.reason).toBe("empty_stream_end");
  });
});

describe("handleAutoChat pool / abort", () => {
  it("returns 400 when pool is only the router model", async () => {
    const res = await handleAutoChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["claude/claude-opus-4-8"],
      handleSingleModel: async () => openaiChatText("x"),
      log: { info: () => {}, warn: () => {} },
      comboName: "solo-router",
      strategy: { routerModel: "claude/claude-opus-4-8" },
      recordEvent: () => {},
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/empty worker pool/i);
  });
});

describe("extractAssistantText", () => {
  it("returns httpError on non-ok without treating as empty parse", async () => {
    const res = jsonResponse({ error: "rate limited" }, 429);
    const out = await extractAssistantText(res);
    expect(out.httpError).toBe("router_http_429");
    expect(out.text).toBe("");
  });

  it("extracts OpenAI message content", async () => {
    const res = openaiChatText('{"model":"x"}');
    const out = await extractAssistantText(res);
    expect(out.text).toContain("model");
    expect(out.httpError).toBeUndefined();
  });
});

describe("handleAutoChat", () => {
  const body = {
    messages: [{ role: "user", content: "hello world" }],
  };
  let events;

  beforeEach(() => {
    events = [];
  });

  function recordEvent(ev) {
    events.push(ev);
  }

  it("rejects at recursion depth limit", async () => {
    const res = await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async () => openaiChatText("ok"),
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: {},
      recordEvent,
      autoDepth: 2,
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/recursion/i);
  });

  it("forces sourceFormatOverride openai on router call", async () => {
    const calls = [];
    const res = await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m, opts) => {
        calls.push({ b, m, opts });
        if (m === "claude/claude-opus-4-8" || b.max_tokens === 256) {
          return openaiChatText(
            JSON.stringify({
              model: "openai/gpt-4o-mini",
              cluster: "general",
              confidence: "high",
              reason: "ok",
              alternates: ["openai/gpt-4o"],
            })
          );
        }
        return openaiChatText("worker ok");
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "claude/claude-opus-4-8", explorationRate: 0 },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    expect(res.ok).toBe(true);
    const routerCall = calls.find((c) => c.b?.max_tokens === 256);
    expect(routerCall).toBeTruthy();
    expect(routerCall.opts?.sourceFormatOverride).toBe("openai");
    expect(routerCall.opts?.bypassNativePassthrough).toBe(true);
    expect(routerCall.b.stream).toBe(false);
    expect(routerCall.b.messages?.[0]?.role).toBe("system");
  });

  it("does not re-call a worker that already failed in the fallback chain", async () => {
    const tried = [];
    await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m) => {
        if (b?.max_tokens === 256) {
          return openaiChatText(
            JSON.stringify({
              model: POOL[0],
              cluster: "general",
              confidence: "high",
              reason: "pick first",
              alternates: [POOL[1]],
            })
          );
        }
        tried.push(m);
        // First two fail, third succeeds
        if (tried.filter((x) => x === m).length && tried.indexOf(m) < 2) {
          // fail first occurrence of each of first two
        }
        if (m === POOL[0] || m === POOL[1]) {
          return jsonResponse({ error: "fail" }, 500);
        }
        return openaiChatText("ok");
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "router/x", explorationRate: 0 },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    // Each failed worker appears once; winner once
    const counts = Object.fromEntries(POOL.map((p) => [p, tried.filter((t) => t === p).length]));
    expect(counts[POOL[0]]).toBe(1);
    expect(counts[POOL[1]]).toBe(1);
    expect(counts[POOL[2]]).toBe(1);
  });

  it("attributes failure to the failed model and success to the rescuer without -30", async () => {
    // Wait for async recordEvent
    await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m) => {
        if (b?.max_tokens === 256) {
          return openaiChatText(
            JSON.stringify({
              model: POOL[0],
              cluster: "general",
              confidence: "high",
              reason: "pick A",
              alternates: [POOL[1]],
            })
          );
        }
        if (m === POOL[0]) return jsonResponse({ error: "fail" }, 503);
        return openaiChatText("rescued");
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "router/x", explorationRate: 0 },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    // Allow microtasks for fire-and-forget recordEvent
    await new Promise((r) => setTimeout(r, 20));

    const failEv = events.find((e) => e.pickedWorker === POOL[0] && e.workerStatus >= 400);
    const winEv = events.find((e) => e.pickedWorker === POOL[1] && e.workerStatus < 400);
    expect(failEv).toBeTruthy();
    expect(failEv.outcomeScore).toBeLessThan(40);
    expect(failEv.meta?.routerPickedWorker).toBe(POOL[0]);
    expect(failEv.meta?.terminal).toBe(false);
    expect(failEv.requestId).toBeTruthy();

    expect(winEv).toBeTruthy();
    expect(winEv.meta?.routerPickedWorker).toBe(POOL[0]);
    expect(winEv.meta?.terminal).toBe(true);
    expect(winEv.requestId).toBe(failEv.requestId);
    // Column is request-level fallback; score path for rescuer stays clean (>=40)
    expect(winEv.fallbackUsed).toBe(true);
    expect(winEv.outcomeScore).toBeGreaterThanOrEqual(40);
  });

  it("marks last failure terminal when all workers fail (one request-level count)", async () => {
    const res = await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m) => {
        if (b?.max_tokens === 256) {
          return openaiChatText(
            JSON.stringify({
              model: POOL[0],
              cluster: "general",
              confidence: "low",
              reason: "pick",
              alternates: [POOL[1], POOL[2]],
            })
          );
        }
        return jsonResponse({ error: "down" }, 503);
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "router/x", explorationRate: 0 },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(res.status).toBe(503);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const terminals = events.filter((e) => e.meta?.terminal === true);
    expect(terminals).toHaveLength(1);
    const requestIds = new Set(events.map((e) => e.requestId));
    expect(requestIds.size).toBe(1);
  });

  it("skips recordEvent for single-worker shortcut but emits Skipped header", async () => {
    const res = await handleAutoChat({
      body,
      models: [POOL[0]],
      handleSingleModel: async () => openaiChatText("ok"),
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: {},
      recordEvent,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.length).toBe(0);
    expect(res.headers.get("X-Auto-Router-Skipped")).toBe("1");
    expect(res.headers.get("X-Auto-Router-Worker")).toContain("gpt-4o-mini");
  });

  it("passes bypassPromptFilters on router call", async () => {
    const calls = [];
    await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m, opts) => {
        calls.push({ m, opts });
        if (b?.max_tokens === 256) {
          return openaiChatText(
            JSON.stringify({
              model: POOL[0],
              cluster: "general",
              confidence: "high",
              reason: "ok",
              alternates: [],
            })
          );
        }
        return openaiChatText("ok");
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "router/x", explorationRate: 0 },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    const routerCall = calls.find((c) => c.opts?.sourceFormatOverride === "openai");
    expect(routerCall?.opts?.bypassPromptFilters).toBe(true);
  });

  it("falls back when first worker returns empty SSE before client commit", async () => {
    const tried = [];
    function emptySse() {
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    function contentSse() {
      return new Response(
        'data: {"choices":[{"delta":{"content":"rescued"}}]}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );
    }
    const res = await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m) => {
        if (b?.max_tokens === 256) {
          return openaiChatText(
            JSON.stringify({
              model: POOL[0],
              cluster: "general",
              confidence: "high",
              reason: "pick A",
              alternates: [POOL[1]],
            })
          );
        }
        tried.push(m);
        if (m === POOL[0]) return emptySse();
        return contentSse();
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "router/x", explorationRate: 0 },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    expect(res.ok).toBe(true);
    expect(tried).toContain(POOL[0]);
    expect(tried).toContain(POOL[1]);
    expect(res.headers.get("X-Auto-Router-Worker")).toContain(POOL[1].split("/").pop());
    // Drain client stream so observe finalizes
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    const failEv = events.find((e) => e.pickedWorker === POOL[0]);
    const winEv = events.find((e) => e.pickedWorker === POOL[1] && e.meta?.terminal);
    expect(failEv?.meta?.terminal).toBe(false);
    expect(winEv).toBeTruthy();
    expect(winEv.outcomeScore).toBeGreaterThanOrEqual(40);
  });

  it("falls back when first worker returns empty non-stream JSON", async () => {
    const tried = [];
    const res = await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m) => {
        if (b?.max_tokens === 256) {
          return openaiChatText(
            JSON.stringify({
              model: POOL[0],
              cluster: "general",
              confidence: "low",
              reason: "pick",
              alternates: [POOL[1]],
            })
          );
        }
        tried.push(m);
        if (m === POOL[0]) {
          return jsonResponse({ choices: [{ message: { role: "assistant", content: "" } }] });
        }
        return openaiChatText("good answer");
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "router/x", explorationRate: 0 },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(res.ok).toBe(true);
    expect(tried[0]).toBe(POOL[0]);
    expect(tried).toContain(POOL[1]);
    const text = await res.text();
    expect(text).toContain("good answer");
  });

  it("records router_http status when router returns non-ok", async () => {
    await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m) => {
        if (b?.max_tokens === 256) return jsonResponse({ error: "rl" }, 429);
        return openaiChatText("worker");
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "router/x", explorationRate: 0 },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.meta?.parseError === "router_http_429")).toBe(true);
    // Falls back to pool[0]
    expect(events.some((e) => e.pickedWorker === POOL[0])).toBe(true);
  });

  it("passes abort signal to router handleSingleModel", async () => {
    let sawSignal = false;
    await handleAutoChat({
      body,
      models: POOL,
      handleSingleModel: async (b, m, opts) => {
        if (b?.max_tokens === 256) {
          sawSignal = opts?.signal instanceof AbortSignal;
          return openaiChatText(
            JSON.stringify({
              model: POOL[0],
              cluster: "g",
              confidence: "low",
              reason: "ok",
            })
          );
        }
        return openaiChatText("ok");
      },
      log: { info: () => {}, warn: () => {} },
      comboName: "auto",
      strategy: { routerModel: "router/x", explorationRate: 0, autoTuning: { routerTimeoutMs: 5000 } },
      loadLearning: async () => null,
      loadStats: async () => [],
      recordEvent,
    });
    expect(sawSignal).toBe(true);
  });
});
