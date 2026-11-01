// Regression coverage for the 2026-11-01 V8 heap OOM (SIGABRT after ~12h).
// Three defenses, all pure logic:
//  1. Stream log retention is bounded (full output was held in RAM only to be
//     truncated to a 5 KB preview by requestDetailsRepo).
//  2. The heap watchdog restarts only on *sustained* critical pressure.
//  3. Old-space sizing scales with host RAM instead of a fixed 6144 MB.
import { describe, expect, it } from "vitest";
import {
  createBoundedTextAccumulator,
  streamPreviewMaxChars,
  DEFAULT_STREAM_PREVIEW_MAX_CHARS,
} from "../../open-sse/utils/boundedText.js";
import {
  evaluateMemoryPressure,
  resolveMemoryWatchdogConfig,
} from "../../src/lib/memoryWatchdog.js";
import {
  resolveMaxOldSpaceMb,
  nodeOptionsHasMaxOldSpace,
} from "../../scripts/heapSizing.mjs";

describe("createBoundedTextAccumulator", () => {
  it("returns short text verbatim", () => {
    const acc = createBoundedTextAccumulator(100);
    acc.append("hello ");
    acc.append("world");
    expect(acc.text()).toBe("hello world");
    expect(acc.totalLength).toBe(11);
    expect(acc.truncated).toBe(false);
  });

  it("bounds retained text while keeping head and tail", () => {
    const acc = createBoundedTextAccumulator(20);
    acc.append("0123456789"); // fills head (10)
    acc.append("ABCDEFGHIJ"); // fills tail (10)
    acc.append("XYZ"); // pushes oldest tail chars out
    expect(acc.totalLength).toBe(23);
    expect(acc.truncated).toBe(true);
    expect(acc.retainedLength).toBeLessThanOrEqual(20);
    const text = acc.text();
    expect(text.startsWith("0123456789")).toBe(true);
    expect(text.endsWith("XYZ")).toBe(true);
    expect(text).toContain("truncated 3 chars");
  });

  it("stays bounded under many small deltas (streaming shape)", () => {
    const acc = createBoundedTextAccumulator(1024);
    for (let i = 0; i < 5000; i++) acc.append("token ");
    expect(acc.totalLength).toBe(5000 * 6);
    expect(acc.retainedLength).toBeLessThanOrEqual(1024);
    expect(acc.text().length).toBeLessThan(1200);
  });

  it("ignores non-string and empty appends", () => {
    const acc = createBoundedTextAccumulator(10);
    acc.append("");
    acc.append(null);
    acc.append(undefined);
    acc.append(42);
    expect(acc.totalLength).toBe(0);
    expect(acc.text()).toBe("");
  });

  it("honors STREAM_LOG_PREVIEW_MAX_CHARS with a sane default", () => {
    expect(streamPreviewMaxChars({})).toBe(DEFAULT_STREAM_PREVIEW_MAX_CHARS);
    expect(streamPreviewMaxChars({ STREAM_LOG_PREVIEW_MAX_CHARS: "4096" })).toBe(4096);
    expect(streamPreviewMaxChars({ STREAM_LOG_PREVIEW_MAX_CHARS: "junk" })).toBe(DEFAULT_STREAM_PREVIEW_MAX_CHARS);
    expect(streamPreviewMaxChars({ STREAM_LOG_PREVIEW_MAX_CHARS: "-5" })).toBe(DEFAULT_STREAM_PREVIEW_MAX_CHARS);
  });
});

describe("memory watchdog pressure evaluation", () => {
  const config = resolveMemoryWatchdogConfig({});

  it("defaults are enabled with warn below critical", () => {
    expect(config.enabled).toBe(true);
    expect(config.warnFraction).toBeGreaterThan(0);
    expect(config.warnFraction).toBeLessThan(config.criticalFraction);
    expect(config.criticalFraction).toBeLessThan(1);
    expect(config.criticalSamples).toBeGreaterThanOrEqual(2);
  });

  it("can be disabled via env", () => {
    expect(resolveMemoryWatchdogConfig({ SWITCHBOARD_MEMORY_WATCHDOG: "0" }).enabled).toBe(false);
  });

  it("does not restart on a single critical sample", () => {
    const r = evaluateMemoryPressure({ fraction: 0.99, consecutiveCritical: 0 }, config);
    expect(r.level).toBe("critical");
    expect(r.shouldRestart).toBe(false);
    expect(r.consecutiveCritical).toBe(1);
  });

  it("restarts after sustained critical samples", () => {
    let state = { fraction: 0.99, consecutiveCritical: 0 };
    let r;
    for (let i = 0; i < config.criticalSamples; i++) {
      r = evaluateMemoryPressure(state, config);
      state = { fraction: 0.99, consecutiveCritical: r.consecutiveCritical };
    }
    expect(r.shouldRestart).toBe(true);
  });

  it("resets the sustained counter when pressure drops", () => {
    const hot = evaluateMemoryPressure({ fraction: 0.99, consecutiveCritical: 3 }, config);
    const cool = evaluateMemoryPressure({ fraction: 0.5, consecutiveCritical: hot.consecutiveCritical }, config);
    expect(cool.level).toBe("ok");
    expect(cool.consecutiveCritical).toBe(0);
    expect(cool.shouldRestart).toBe(false);
  });

  it("warns between warn and critical without counting toward restart", () => {
    const mid = (config.warnFraction + config.criticalFraction) / 2;
    const r = evaluateMemoryPressure({ fraction: mid, consecutiveCritical: 2 }, config);
    expect(r.level).toBe("warn");
    expect(r.consecutiveCritical).toBe(0);
    expect(r.shouldRestart).toBe(false);
  });
});

describe("resolveMaxOldSpaceMb", () => {
  const GiB = 1024 ** 3;

  it("keeps 6144 MB on large hosts (24 GiB production mini)", () => {
    expect(resolveMaxOldSpaceMb({ env: {}, totalMemBytes: 24 * GiB })).toBe(6144);
  });

  it("scales down on small hosts instead of inviting the kernel OOM killer", () => {
    expect(resolveMaxOldSpaceMb({ env: {}, totalMemBytes: 4 * GiB })).toBe(2048);
    expect(resolveMaxOldSpaceMb({ env: {}, totalMemBytes: 2 * GiB })).toBe(1024);
    expect(resolveMaxOldSpaceMb({ env: {}, totalMemBytes: 1 * GiB })).toBe(512);
  });

  it("honors an explicit override", () => {
    expect(resolveMaxOldSpaceMb({ env: { SWITCHBOARD_MAX_OLD_SPACE_MB: "8192" }, totalMemBytes: 2 * GiB })).toBe(8192);
  });

  it("ignores a bogus override", () => {
    expect(resolveMaxOldSpaceMb({ env: { SWITCHBOARD_MAX_OLD_SPACE_MB: "junk" }, totalMemBytes: 24 * GiB })).toBe(6144);
  });

  it("detects an operator-provided NODE_OPTIONS heap flag", () => {
    expect(nodeOptionsHasMaxOldSpace({ NODE_OPTIONS: "--max-old-space-size=4096" })).toBe(true);
    expect(nodeOptionsHasMaxOldSpace({ NODE_OPTIONS: "--report-on-fatalerror" })).toBe(false);
    expect(nodeOptionsHasMaxOldSpace({})).toBe(false);
  });
});
