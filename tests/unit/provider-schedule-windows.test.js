import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_VALUES,
  DEEPSEEK_CURRENT_PRESET,
  SCHEDULE_DAY_LABELS,
  SCHEDULE_PRESETS,
  dormantAvailabilityModels,
  filterModelsByAvailability,
  formatCountdown,
  getScheduleStatus,
  isValidTimeZone,
  nextTransitionMs,
  normalizeModelAvailability,
  normalizeScheduleConfig,
} from "../../src/shared/utils/scheduleWindows.js";
import { applyScheduleGate, attachScheduleSkips } from "../../src/sse/services/scheduleGate.js";
import { sanitizeStrategyInput, ComboWriteError } from "../../src/lib/combos/comboWrites.js";

// 2026-09-10 is a Thursday; 2026-09-12 Saturday; 2026-09-13 Sunday.
const T = (s) => Date.parse(s);

const deepseekPeak = { deepseek: DEEPSEEK_CURRENT_PRESET };

describe("getScheduleStatus", () => {
  it("matches DeepSeek's published weekday double peak window", () => {
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T02:00:00Z"))).toBe("peak");
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T03:59:00Z"))).toBe("peak");
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T06:00:00Z"))).toBe("peak");
    // gap between the two windows
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T05:00:00Z"))).toBe("offPeak");
    // end is exclusive, start inclusive
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T04:00:00Z"))).toBe("offPeak");
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T01:00:00Z"))).toBe("peak");
  });

  it("treats the whole weekend as off-peak (weekday-scoped windows)", () => {
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-12T02:00:00Z"))).toBe("offPeak");
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-13T23:00:00Z"))).toBe("offPeak");
  });

  it("handles windows that wrap past midnight on the listed days", () => {
    const wrap = {
      timezone: "UTC",
      defaultState: "offPeak",
      windows: [{ type: "peak", start: "22:00", end: "02:00" }],
    };
    expect(getScheduleStatus(wrap, T("2026-09-10T22:00:00Z"))).toBe("peak");
    expect(getScheduleStatus(wrap, T("2026-09-10T23:30:00Z"))).toBe("peak");
    // head of the following day still belongs to yesterday's window
    expect(getScheduleStatus(wrap, T("2026-09-11T01:00:00Z"))).toBe("peak");
    expect(getScheduleStatus(wrap, T("2026-09-11T03:00:00Z"))).toBe("offPeak");
    expect(getScheduleStatus(wrap, T("2026-09-10T21:59:00Z"))).toBe("offPeak");
  });

  it("honors a wrap window scoped to specific weekdays", () => {
    const fridayNight = {
      timezone: "UTC",
      defaultState: "offPeak",
      windows: [{ type: "peak", start: "22:00", end: "02:00", days: ["fri"] }],
    };
    // Friday 2026-09-11 23:00 and Saturday 01:00 are peak; Saturday 22:00 is not.
    expect(getScheduleStatus(fridayNight, T("2026-09-11T23:00:00Z"))).toBe("peak");
    expect(getScheduleStatus(fridayNight, T("2026-09-12T01:00:00Z"))).toBe("peak");
    expect(getScheduleStatus(fridayNight, T("2026-09-12T22:00:00Z"))).toBe("offPeak");
  });

  it("evaluates windows in the schedule's timezone", () => {
    // 09:00-17:00 New York (EDT = UTC-4 in September 2026)
    const ny = {
      timezone: "America/New_York",
      defaultState: "offPeak",
      windows: [{ type: "peak", start: "09:00", end: "17:00", days: ["mon", "tue", "wed", "thu", "fri"] }],
    };
    expect(getScheduleStatus(ny, T("2026-09-10T13:00:00Z"))).toBe("peak"); // 09:00 EDT
    expect(getScheduleStatus(ny, T("2026-09-10T12:59:00Z"))).toBe("offPeak");
    expect(getScheduleStatus(ny, T("2026-09-10T20:59:00Z"))).toBe("peak"); // 16:59 EDT
    expect(getScheduleStatus(ny, T("2026-09-10T21:00:00Z"))).toBe("offPeak");
  });

  it("falls back to defaultState outside every window", () => {
    expect(getScheduleStatus(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T12:00:00Z"))).toBe("offPeak");
    // old-DeepSeek shape: the discount window is the exception, everything else peak
    const oldDs = {
      timezone: "UTC",
      defaultState: "peak",
      windows: [{ type: "offPeak", start: "16:30", end: "00:30" }],
    };
    expect(getScheduleStatus(oldDs, T("2026-09-10T20:00:00Z"))).toBe("offPeak");
    expect(getScheduleStatus(oldDs, T("2026-09-10T10:00:00Z"))).toBe("peak");
  });

  it("returns unscheduled for missing or windowless schedules", () => {
    expect(getScheduleStatus(null, T("2026-09-10T12:00:00Z"))).toBe("unscheduled");
    expect(getScheduleStatus({}, T("2026-09-10T12:00:00Z"))).toBe("unscheduled");
    expect(getScheduleStatus({ windows: [] }, T("2026-09-10T12:00:00Z"))).toBe("unscheduled");
  });

  it("validates IANA timezones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("nextTransitionMs", () => {
  it("finds the end of the current window", () => {
    expect(nextTransitionMs(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T02:00:00Z"))).toBe(T("2026-09-10T04:00:00Z"));
  });

  it("finds the start of the next window from inside a gap", () => {
    expect(nextTransitionMs(DEEPSEEK_CURRENT_PRESET, T("2026-09-10T05:00:00Z"))).toBe(T("2026-09-10T06:00:00Z"));
  });

  it("jumps the weekend to Monday's first window", () => {
    expect(nextTransitionMs(DEEPSEEK_CURRENT_PRESET, T("2026-09-11T12:00:00Z"))).toBe(T("2026-09-14T01:00:00Z"));
    expect(nextTransitionMs(DEEPSEEK_CURRENT_PRESET, T("2026-09-12T02:00:00Z"))).toBe(T("2026-09-14T01:00:00Z"));
  });

  it("resolves a wrap window's end to the following day", () => {
    const wrap = {
      timezone: "UTC",
      defaultState: "offPeak",
      windows: [{ type: "peak", start: "22:00", end: "02:00" }],
    };
    expect(nextTransitionMs(wrap, T("2026-09-10T23:00:00Z"))).toBe(T("2026-09-11T02:00:00Z"));
    expect(nextTransitionMs(wrap, T("2026-09-11T03:00:00Z"))).toBe(T("2026-09-11T22:00:00Z"));
  });

  it("returns null for unscheduled schedules", () => {
    expect(nextTransitionMs(null, T("2026-09-10T12:00:00Z"))).toBeNull();
  });

  it("survives DST spring-forward: a wall-clock span that no longer exists never matches", () => {
    // US 2027 spring forward: Sun 2027-03-14, 02:00→03:00 America/New_York.
    const jump = {
      timezone: "America/New_York",
      defaultState: "offPeak",
      windows: [{ type: "peak", start: "02:00", end: "03:00", days: ["sun"] }],
    };
    expect(getScheduleStatus(jump, T("2027-03-14T06:30:00Z"))).toBe("offPeak"); // 01:30 EST
    expect(getScheduleStatus(jump, T("2027-03-14T07:30:00Z"))).toBe("offPeak"); // 03:30 EDT
    // The same window matches on an ordinary Sunday.
    expect(getScheduleStatus(jump, T("2027-03-21T06:30:00Z"))).toBe("peak"); // 02:30 EDT
  });

  it("survives DST fall-back: the repeated hour matches at both instants", () => {
    // US 2027 fall back: Sun 2027-11-07, 02:00→01:00 America/New_York.
    const fall = {
      timezone: "America/New_York",
      defaultState: "offPeak",
      windows: [{ type: "peak", start: "01:00", end: "01:30", days: ["sun"] }],
    };
    expect(getScheduleStatus(fall, T("2027-11-07T05:15:00Z"))).toBe("peak"); // 01:15 EDT
    expect(getScheduleStatus(fall, T("2027-11-07T06:15:00Z"))).toBe("peak"); // 01:15 EST (repeated hour)
    expect(getScheduleStatus(fall, T("2027-11-07T07:15:00Z"))).toBe("offPeak"); // 02:15 EST
    expect(nextTransitionMs(fall, T("2027-11-07T05:15:00Z"))).toBe(T("2027-11-07T05:30:00Z"));
  });

  it("finds the re-entry transition into the repeated hour on fall-back days", () => {
    // Between the two occurrences (01:45 EDT) the status is offPeak; the window
    // re-enters at the SECOND 01:00 (06:00Z), not a day later.
    const fall = {
      timezone: "America/New_York",
      defaultState: "offPeak",
      windows: [{ type: "peak", start: "01:00", end: "01:30" }],
    };
    expect(getScheduleStatus(fall, T("2026-11-01T06:01:00Z"))).toBe("peak");
    expect(nextTransitionMs(fall, T("2026-11-01T05:45:00Z"))).toBe(T("2026-11-01T06:00:00Z"));
    expect(nextTransitionMs(fall, T("2026-11-01T06:15:00Z"))).toBe(T("2026-11-01T06:30:00Z"));
  });
});

describe("SCHEDULE_PRESETS", () => {
  it("ships only configs that pass schedule validation", () => {
    expect(SCHEDULE_PRESETS.length).toBeGreaterThan(0);
    for (const preset of SCHEDULE_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.label).toBeTruthy();
      const check = normalizeScheduleConfig(preset.config, preset.id);
      expect(check.error).toBeUndefined();
      // Every preset must produce a non-unscheduled status somewhere.
      expect(getScheduleStatus(preset.config)).not.toBe("unscheduled");
    }
  });

  it("keeps the historical DeepSeek discount shape (offPeak window, peak default)", () => {
    const old = SCHEDULE_PRESETS.find((p) => p.id === "deepseek-2025-02");
    expect(old.config.defaultState).toBe("peak");
    expect(getScheduleStatus(old.config, T("2026-09-10T20:00:00Z"))).toBe("offPeak");
    expect(getScheduleStatus(old.config, T("2026-09-10T10:00:00Z"))).toBe("peak");
  });
});

describe("formatCountdown", () => {
  it("renders minutes and hours like the 503 message and dashboard badges", () => {
    expect(formatCountdown(30_000)).toBe("1 min");
    expect(formatCountdown(45 * 60_000)).toBe("45 min");
    expect(formatCountdown(3 * 60 * 60_000)).toBe("3h");
    expect(formatCountdown((3 * 60 + 12) * 60_000)).toBe("3h 12m");
  });
});

describe("filterModelsByAvailability", () => {
  const availability = {
    "deepseek/deepseek-chat": "off-peak-only",
    "openai/gpt-4o-mini": "peak-only",
  };

  it("skips models whose rule excludes the current status and keeps the rest in order", () => {
    const models = ["deepseek/deepseek-chat", "openai/gpt-4o-mini", "grok/grok-4"];
    // Thursday 02:00 UTC: deepseek peak → skipped; openai has no schedule → dormant → kept
    const result = filterModelsByAvailability(models, deepseekPeak, availability, T("2026-09-10T02:00:00Z"));
    expect(result.models).toEqual(["openai/gpt-4o-mini", "grok/grok-4"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      model: "deepseek/deepseek-chat",
      provider: "deepseek",
      availability: "off-peak-only",
      status: "peak",
    });
    expect(result.skipped[0].untilMs).toBe(T("2026-09-10T04:00:00Z"));
  });

  it("keeps off-peak-only models during off-peak hours", () => {
    const result = filterModelsByAvailability(
      ["deepseek/deepseek-chat"],
      deepseekPeak,
      availability,
      T("2026-09-10T12:00:00Z"),
    );
    expect(result.models).toEqual(["deepseek/deepseek-chat"]);
    expect(result.skipped).toEqual([]);
  });

  it("keeps peak-only models during peak hours", () => {
    const result = filterModelsByAvailability(
      ["deepseek/deepseek-chat"],
      deepseekPeak,
      { "deepseek/deepseek-chat": "peak-only" },
      T("2026-09-10T02:00:00Z"),
    );
    expect(result.models).toEqual(["deepseek/deepseek-chat"]);
  });

  it("fail-opens when the provider has no schedule (dormant rule)", () => {
    const result = filterModelsByAvailability(
      ["deepseek/deepseek-chat"],
      {},
      availability,
      T("2026-09-10T02:00:00Z"),
    );
    expect(result.models).toEqual(["deepseek/deepseek-chat"]);
    expect(result.skipped).toEqual([]);
  });

  it("passes through untouched when no rules are configured", () => {
    const models = ["a/b", "c/d"];
    expect(filterModelsByAvailability(models, deepseekPeak, {}, T("2026-09-10T02:00:00Z")).models).toEqual(models);
  });

  it("flags dormant rules for the dashboard warning", () => {
    const rules = { "deepseek/deepseek-chat": "off-peak-only", "openai/gpt-4o-mini": "peak-only" };
    expect(dormantAvailabilityModels(deepseekPeak, rules)).toEqual(["openai/gpt-4o-mini"]);
    expect(dormantAvailabilityModels({}, rules)).toEqual(Object.keys(rules));
    expect(dormantAvailabilityModels(deepseekPeak, null)).toEqual([]);
  });
});

describe("normalizeScheduleConfig", () => {
  it("accepts and normalizes the DeepSeek preset", () => {
    const result = normalizeScheduleConfig(DEEPSEEK_CURRENT_PRESET, "deepseek");
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(DEEPSEEK_CURRENT_PRESET);
  });

  it("fills defaults for timezone and defaultState", () => {
    const result = normalizeScheduleConfig({ windows: [{ type: "peak", start: "01:00", end: "02:00" }] }, "p");
    expect(result.value.timezone).toBe("UTC");
    expect(result.value.defaultState).toBe("offPeak");
    expect(result.value.windows[0].days).toEqual([...SCHEDULE_DAY_LABELS]);
  });

  it("trims and canonicalizes timezone casing on save", () => {
    const result = normalizeScheduleConfig(
      { timezone: " america/new_york ", windows: [{ type: "peak", start: "01:00", end: "02:00" }] },
      "p",
    );
    expect(result.value.timezone).toBe("America/New_York");
  });

  it("never throws on an invalid timezone — status degrades to unscheduled", () => {
    // This is the mid-keystroke state of the dashboard's free-text picker.
    const midEdit = { timezone: "Ame", defaultState: "offPeak", windows: [{ type: "peak", start: "09:00", end: "17:00" }] };
    expect(getScheduleStatus(midEdit)).toBe("unscheduled");
    expect(nextTransitionMs(midEdit)).toBeNull();
    // A gated model under an unparseable schedule fails open (dormant), never throws.
    const result = filterModelsByAvailability(["x/y"], { x: midEdit }, { "x/y": "peak-only" });
    expect(result.models).toEqual(["x/y"]);
  });

  it("rejects invalid shapes", () => {
    expect(normalizeScheduleConfig(null, "p").error).toMatch(/must be an object/);
    expect(normalizeScheduleConfig({ windows: [] }, "p").error).toMatch(/at least one time window/);
    expect(normalizeScheduleConfig({ timezone: "Not/AZone", windows: [{ type: "peak", start: "01:00", end: "02:00" }] }, "p").error).toMatch(/IANA zone/);
    expect(normalizeScheduleConfig({ windows: [{ type: "peak", start: "1:00", end: "02:00" }] }, "p").error).toMatch(/HH:MM/);
    expect(normalizeScheduleConfig({ windows: [{ type: "peak", start: "01:00", end: "01:00" }] }, "p").error).toMatch(/must differ/);
    expect(normalizeScheduleConfig({ windows: [{ type: "sometimes", start: "01:00", end: "02:00" }] }, "p").error).toMatch(/"peak" or "offPeak"/);
    expect(normalizeScheduleConfig({ windows: [{ type: "peak", start: "01:00", end: "02:00", days: ["funday"] }] }, "p").error).toMatch(/days/);
    expect(normalizeScheduleConfig({ defaultState: "busy", windows: [{ type: "peak", start: "01:00", end: "02:00" }] }, "p").error).toMatch(/defaultState/);
  });

  it("caps the number of windows", () => {
    const windows = Array.from({ length: 15 }, (_, i) => ({
      type: "peak",
      start: `0${i % 10}:00`.slice(-5),
      end: "23:00",
    }));
    expect(normalizeScheduleConfig({ windows }, "p").error).toMatch(/at most 14 windows/);
  });
});

describe("normalizeModelAvailability", () => {
  it("accepts valid rules and drops always entries", () => {
    const result = normalizeModelAvailability({
      "deepseek/deepseek-chat": "off-peak-only",
      "openai/gpt-4o-mini": "always",
    });
    expect(result.value).toEqual({ "deepseek/deepseek-chat": "off-peak-only" });
  });

  it("accepts null/undefined as empty", () => {
    expect(normalizeModelAvailability(null).value).toEqual({});
    expect(normalizeModelAvailability(undefined).value).toEqual({});
  });

  it("rejects bad values and dangerous keys, accepts bare provider-id members", () => {
    expect(normalizeModelAvailability({ "a/b": "sometimes" }).error).toMatch(/must be one of/);
    // webSearch/webFetch combo members are bare provider ids ("tavily").
    expect(normalizeModelAvailability({ tavily: "peak-only" }).value).toEqual({ tavily: "peak-only" });
    // Slashless keys that aren't providers (e.g. nested combo names) are
    // accepted but stay dormant at runtime — providerOfModel never matches a
    // schedule, so they fail open.
    // JSON.parse can create an own "__proto__" key — the validator must reject it.
    const crafted = JSON.parse('{"__proto__": "peak-only"}');
    expect(Object.keys(crafted)).toEqual(["__proto__"]);
    expect(normalizeModelAvailability(crafted).error).toMatch(/not a valid combo member/);
    expect(normalizeModelAvailability(["a/b"]).error).toMatch(/must be an object/);
    expect(AVAILABILITY_VALUES).toEqual(["always", "peak-only", "off-peak-only"]);
  });
});

describe("applyScheduleGate", () => {
  const noopLog = { info: () => {}, warn: () => {} };

  const settingsFor = (schedules, availability) => ({
    providerSchedules: schedules,
    comboStrategies: { cheap_models: { modelAvailability: availability } },
  });

  it("is a zero-cost passthrough when the combo has no rules", () => {
    const models = ["a/b", "c/d"];
    const gate = applyScheduleGate({ models, comboName: "cheap_models", settings: { providerSchedules: deepseekPeak }, log: noopLog });
    expect(gate.models).toEqual(models);
    expect(gate.skipped).toEqual([]);
    expect(gate.blocked).toBe(false);
    expect(gate.response).toBeNull();
  });

  it("drops gated members and keeps the rest (cheap_models + deepseek off-peak-only)", () => {
    const settings = settingsFor(deepseekPeak, { "deepseek/deepseek-chat": "off-peak-only" });
    const gate = applyScheduleGate({
      models: ["deepseek/deepseek-chat", "openai/gpt-4o-mini"],
      comboName: "cheap_models",
      settings,
      log: noopLog,
    });
    expect(gate.models).toEqual(["openai/gpt-4o-mini"]);
    expect(gate.blocked).toBe(false);
    expect(gate.response).toBeNull();
  });

  it("returns a fail-closed 503 with Retry-After when every member is gated", async () => {
    const settings = settingsFor(deepseekPeak, { "deepseek/deepseek-chat": "off-peak-only" });
    const gate = applyScheduleGate({
      models: ["deepseek/deepseek-chat"],
      comboName: "cheap_models",
      settings,
      log: noopLog,
    });
    expect(gate.blocked).toBe(true);
    expect(gate.models).toEqual([]);
    expect(gate.response).toBeInstanceOf(Response);
    expect(gate.response.status).toBe(503);
    expect(Number(gate.response.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await gate.response.json();
    expect(body.error.message).toContain("cheap_models");
    expect(body.error.message).toContain("off-peak-only");
  });

  it("fail-opens dormant rules (provider schedule deleted, rule kept)", () => {
    const settings = settingsFor({}, { "deepseek/deepseek-chat": "off-peak-only" });
    const gate = applyScheduleGate({
      models: ["deepseek/deepseek-chat"],
      comboName: "cheap_models",
      settings,
      log: noopLog,
    });
    expect(gate.models).toEqual(["deepseek/deepseek-chat"]);
    expect(gate.blocked).toBe(false);
  });
});

describe("attachScheduleSkips", () => {
  it("attaches skips to the first event only, leaving later events untouched", () => {
    /** @type {any[]} */
    const recorded = [];
    const record = attachScheduleSkips((ev) => { recorded.push(ev); return ev; }, [
      { model: "deepseek/deepseek-chat", provider: "deepseek", availability: "off-peak-only", status: "peak", untilMs: T("2026-09-10T04:00:00Z") },
    ]);
    record({ comboName: "x", meta: { picked: true } });
    record({ comboName: "x", meta: { fallback: true } });
    expect(recorded[0].meta.scheduleSkips).toHaveLength(1);
    expect(recorded[0].meta.scheduleSkips[0].until).toBe("2026-09-10T04:00:00.000Z");
    expect(recorded[0].meta.picked).toBe(true);
    expect(recorded[1].meta.scheduleSkips).toBeUndefined();
  });

  it("returns the recorder unchanged when nothing was skipped", () => {
    const record = () => "ok";
    expect(attachScheduleSkips(record, [])).toBe(record);
  });
});

describe("sanitizeStrategyInput (modelAvailability)", () => {
  it("keeps valid rules and drops always entries", () => {
    const safe = sanitizeStrategyInput({
      fallbackStrategy: "fallback",
      modelAvailability: { "deepseek/deepseek-chat": "off-peak-only", "a/b": "always" },
    });
    expect(safe.modelAvailability).toEqual({ "deepseek/deepseek-chat": "off-peak-only" });
  });

  it("rejects invalid rule values instead of silently dropping them", () => {
    expect(() => sanitizeStrategyInput({ modelAvailability: { "a/b": "sometimes" } })).toThrow(ComboWriteError);
  });

  it("drops the key entirely when all rules are always/empty", () => {
    const safe = sanitizeStrategyInput({ modelAvailability: { "a/b": "always" } });
    expect(safe).not.toHaveProperty("modelAvailability");
  });
});
