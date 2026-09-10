// @ts-check
/**
 * Provider peak/off-peak schedule evaluation.
 *
 * A schedule is stored at `settings.providerSchedules[providerId]`:
 *   { timezone: "UTC", defaultState: "offPeak", windows: [...] }
 * Each window: { type: "peak"|"offPeak", start: "HH:MM", end: "HH:MM", days: ["mon",...] }
 * A window span is [start, end); start > end wraps past midnight into the next
 * day. `days` defaults to all seven. Status of "now" is the FIRST matching
 * window's type, else `defaultState` — this expresses both "peak is the
 * exception" (DeepSeek today) and "the discount window is the exception"
 * (DeepSeek Feb-2025) without complement math.
 *
 * Pure and dependency-free so the request path (src/sse) and the dashboard
 * (client components) evaluate identically. All timezone math goes through
 * Intl.DateTimeFormat, so DST is handled by the platform.
 */

/** @typedef {"peak" | "offPeak"} ScheduleState */
/** @typedef {"unscheduled" | "peak" | "offPeak"} ScheduleStatus */

export const SCHEDULE_STATES = /** @type {const} */ (["peak", "offPeak"]);
export const AVAILABILITY_VALUES = /** @type {const} */ (["always", "peak-only", "off-peak-only"]);
export const SCHEDULE_DAY_LABELS = /** @type {const} */ (["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const DAY_SET = new Set(SCHEDULE_DAY_LABELS);
const AVAILABILITY_SET = new Set(AVAILABILITY_VALUES);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Boundaries are scanned this many days ahead; 8 covers wrap windows + any weekday. */
const TRANSITION_SCAN_DAYS = 8;

/** DeepSeek's current published policy (verified 2026-09-10): weekday double peak window. */
export const DEEPSEEK_CURRENT_PRESET = {
  timezone: "UTC",
  defaultState: "offPeak",
  windows: [
    { type: "peak", start: "01:00", end: "04:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    { type: "peak", start: "06:00", end: "10:00", days: ["mon", "tue", "wed", "thu", "fri"] },
  ],
};

/**
 * Small library of known time-priced provider policies. Providers move their
 * windows, so a preset only SEEDS the editor — the stored config is always the
 * user's explicit copy. Verify against the provider's pricing page before
 * trusting a preset.
 */
export const SCHEDULE_PRESETS = [
  {
    id: "deepseek-current",
    label: "DeepSeek (current): peak 01:00–04:00 & 06:00–10:00 UTC, Mon–Fri",
    config: DEEPSEEK_CURRENT_PRESET,
  },
  {
    id: "deepseek-2025-02",
    label: "DeepSeek (Feb 2025): off-peak 16:30–00:30 UTC daily",
    config: {
      timezone: "UTC",
      defaultState: "peak",
      windows: [{ type: "offPeak", start: "16:30", end: "00:30" }],
    },
  },
];

// ---- Intl plumbing -----------------------------------------------------------

const formatterCache = new Map();

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function getFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * @param {string} timeZone
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    formatterCache.delete(timeZone);
    return false;
  }
}

/**
 * Wall-clock parts of an instant in a timezone.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {{ weekday: string, year: number, month: number, day: number, hour: number, minute: number, minutes: number }}
 */
function wallClockOf(ms, timeZone) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of getFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    weekday: parts.weekday.toLowerCase(),
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

/**
 * Convert a wall-clock time in a timezone to an epoch instant (iterative
 * UTC-projection; converges in ≤3 passes, DST-transition safe).
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} wall
 * @param {string} timeZone
 * @returns {number}
 */
function wallClockToInstant(wall, timeZone) {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let ts = target;
  for (let i = 0; i < 3; i++) {
    const w = wallClockOf(ts, timeZone);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    const diff = asUtc - target;
    if (diff === 0) break;
    ts -= diff;
  }
  return ts;
}

// ---- Schedule evaluation -----------------------------------------------------

/**
 * @param {string} hhmm
 * @returns {number} minutes since midnight
 */
function parseHm(hhmm) {
  const m = TIME_RE.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

/**
 * Window's day set; absent/invalid means every day.
 * @param {any} window
 * @returns {Set<string>}
 */
function windowDays(window) {
  if (Array.isArray(window?.days) && window.days.length) {
    return new Set(window.days.filter((/** @type {string} */ d) => DAY_SET.has(d)));
  }
  return new Set(SCHEDULE_DAY_LABELS);
}

/**
 * Does a window contain `minutes` on a day whose label is `weekday`?
 * Wrap windows (start > end) match late on their listed days and early on the
 * following day.
 * @param {{ start: string, end: string }} window
 * @param {Set<string>} days
 * @param {string} weekday
 * @param {number} minutes
 */
function windowMatches(window, days, weekday, minutes) {
  const start = parseHm(window.start);
  const end = parseHm(window.end);
  if (start < 0 || end < 0 || start === end) return false;
  if (start < end) {
    return days.has(weekday) && minutes >= start && minutes < end;
  }
  // Wraps midnight: tail of listed days…
  if (days.has(weekday) && minutes >= start) return true;
  // …head of the following day.
  const prevIdx = (SCHEDULE_DAY_LABELS.indexOf(weekday) + 6) % 7;
  const prevDay = SCHEDULE_DAY_LABELS[prevIdx];
  return days.has(prevDay) && minutes < end;
}

/**
 * Current status for a provider schedule. Never throws: an unparseable
 * schedule (or an invalid timezone mid-edit in the dashboard) evaluates as
 * `unscheduled`, which every consumer already treats as fail-open/dormant.
 * @param {any} schedule
 * @param {number} [nowMs]
 * @returns {ScheduleStatus}
 */
export function getScheduleStatus(schedule, nowMs = Date.now()) {
  if (!schedule || typeof schedule !== "object" || !Array.isArray(schedule.windows) || !schedule.windows.length) {
    return "unscheduled";
  }
  try {
    const timeZone = typeof schedule.timezone === "string" && schedule.timezone ? schedule.timezone : "UTC";
    const now = wallClockOf(nowMs, timeZone);
    for (const window of schedule.windows) {
      if (!window || typeof window !== "object") continue;
      if (!windowMatches(window, windowDays(window), now.weekday, now.minutes)) continue;
      return window.type === "peak" ? "peak" : "offPeak";
    }
    return schedule.defaultState === "peak" ? "peak" : "offPeak";
  } catch {
    return "unscheduled";
  }
}

/**
 * Convert a wall-clock time in a timezone to its epoch instant(s). On DST
 * fall-back days an ambiguous wall time occurs twice; both occurrences are
 * returned so boundary scans see the second re-entry too. (Spring-forward
 * gaps resolve to a single instant after the jump — Intl's behavior.)
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} wall
 * @param {string} timeZone
 * @returns {number[]}
 */
function wallClockToInstants(wall, timeZone) {
  const first = wallClockToInstant(wall, timeZone);
  // A fall-back repeated hour sits exactly one absolute hour after its first
  // occurrence with the same wall clock — that identity is the ambiguity test.
  const probe = first + 3_600_000;
  const a = wallClockOf(first, timeZone);
  const b = wallClockOf(probe, timeZone);
  const ambiguous =
    a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute;
  return ambiguous ? [first, probe] : [first];
}

/**
 * Epoch ms of the next status change after `nowMs` (null when the schedule
 * never transitions). Status is piecewise-constant between window boundaries,
 * so it suffices to test each boundary in order.
 * @param {any} schedule
 * @param {number} [nowMs]
 * @returns {number|null}
 */
export function nextTransitionMs(schedule, nowMs = Date.now()) {
  const current = getScheduleStatus(schedule, nowMs);
  if (current === "unscheduled") return null;
  const timeZone = typeof schedule.timezone === "string" && schedule.timezone ? schedule.timezone : "UTC";

  /** @type {number[]} */
  const boundaries = [];
  const base = wallClockOf(nowMs, timeZone);
  for (let offset = -1; offset < TRANSITION_SCAN_DAYS; offset++) {
    // Approximate the date `offset` days away, then rebuild the exact wall date.
    // Noon anchoring keeps the ±24h walk on the intended calendar day across DST.
    const dayMs = 24 * 60 * 60 * 1000;
    const date = wallClockOf(wallClockToInstant(
      { year: base.year, month: base.month, day: base.day, hour: 12, minute: 0 },
      timeZone
    ) + offset * dayMs, timeZone);
    const prevDate = wallClockOf(wallClockToInstant(
      { year: base.year, month: base.month, day: base.day, hour: 12, minute: 0 },
      timeZone
    ) + (offset - 1) * dayMs, timeZone);
    for (const window of schedule.windows) {
      if (!window || typeof window !== "object") continue;
      const start = parseHm(window.start);
      const end = parseHm(window.end);
      if (start < 0 || end < 0 || start === end) continue;
      const days = windowDays(window);
      const midnight = { year: date.year, month: date.month, day: date.day, hour: 0, minute: 0 };
      const at = (/** @type {number} */ minutes) => wallClockToInstants(
        { ...midnight, hour: Math.floor(minutes / 60), minute: minutes % 60 },
        timeZone
      );
      if (days.has(date.weekday)) {
        boundaries.push(...at(start));
        if (end > start) boundaries.push(...at(end));
      }
      if (end < start && days.has(prevDate.weekday)) {
        // A wrap window that started yesterday ends early today.
        boundaries.push(...at(end));
      }
    }
  }
  boundaries.sort((a, b) => a - b);
  for (const boundary of boundaries) {
    if (boundary <= nowMs) continue;
    if (getScheduleStatus(schedule, boundary) !== current) return boundary;
  }
  return null;
}

// ---- Combo filtering -----------------------------------------------------------

/**
 * @param {string} modelStr
 * @returns {string}
 */
export function providerOfModel(modelStr) {
  const value = typeof modelStr === "string" ? modelStr : String(modelStr ?? "");
  const slash = value.indexOf("/");
  return slash === -1 ? value : value.slice(0, slash);
}

/**
 * Apply per-combo model availability rules (`comboStrategies[combo].modelAvailability`)
 * against provider schedules. Rules for providers without a schedule are
 * dormant (fail-open): the model stays eligible. Provider status is computed
 * once per provider per call, not per model.
 * @param {string[]} models
 * @param {Record<string, any>} providerSchedules
 * @param {Record<string, string>} modelAvailability
 * @param {number} [nowMs]
 * @returns {{ models: string[], skipped: Array<{ model: string, provider: string, availability: string, status: ScheduleStatus, untilMs: number }> }}
 */
export function filterModelsByAvailability(models, providerSchedules, modelAvailability, nowMs = Date.now()) {
  /** @type {string[]} */
  const kept = [];
  /** @type {Array<{ model: string, provider: string, availability: string, status: ScheduleStatus, untilMs: number }>} */
  const skipped = [];
  /** @type {Map<string, { status: ScheduleStatus, untilMs: number }>} */
  const providerMemo = new Map();
  const statusFor = (/** @type {string} */ provider) => {
    let memo = providerMemo.get(provider);
    if (!memo) {
      const schedule = providerSchedules?.[provider];
      const status = getScheduleStatus(schedule, nowMs);
      memo = {
        status,
        untilMs: status === "unscheduled"
          ? 0
          : nextTransitionMs(schedule, nowMs) ?? nowMs + 24 * 60 * 60 * 1000,
      };
      providerMemo.set(provider, memo);
    }
    return memo;
  };
  for (const model of Array.isArray(models) ? models : []) {
    const rule = modelAvailability?.[model];
    if (!rule || rule === "always") {
      kept.push(model);
      continue;
    }
    const provider = providerOfModel(model);
    const { status, untilMs } = statusFor(provider);
    if (status === "unscheduled") {
      kept.push(model); // dormant rule — never gate on a missing schedule
      continue;
    }
    const allowed = rule === "peak-only" ? status === "peak" : status === "offPeak";
    if (allowed) {
      kept.push(model);
    } else {
      skipped.push({ model, provider, availability: rule, status, untilMs });
    }
  }
  return { models: kept, skipped };
}

// ---- Validation (settings PATCH + strategy writes share these) ------------------

/**
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and normalize one provider schedule. Returns `{ error }` on a bad
 * shape or `{ value }` with a normalized copy (sorted days, defaults filled).
 * @param {any} schedule
 * @param {string} providerId - for error messages
 * @returns {{ error: string } | { value: { timezone: string, defaultState: ScheduleState, windows: any[] } }}
 */
export function normalizeScheduleConfig(schedule, providerId) {
  if (!isPlainObject(schedule)) {
    return { error: `Provider "${providerId}" schedule must be an object.` };
  }
  const rawTimezone = typeof schedule.timezone === "string" ? schedule.timezone.trim() : "";
  const timezone = rawTimezone || "UTC";
  if (!isValidTimeZone(timezone)) {
    return { error: `Provider "${providerId}" schedule timezone "${timezone}" is not a valid IANA zone.` };
  }
  let canonicalTimezone = timezone;
  try {
    // Canonicalize casing (" utc " → "UTC") so persisted values match the
    // picker's suggestions and don't rely on V8's case-insensitive leniency.
    canonicalTimezone = getFormatter(timezone).resolvedOptions().timeZone || timezone;
  } catch {
    /* keep the validated spelling */
  }
  if (!Array.isArray(schedule.windows) || schedule.windows.length === 0) {
    return { error: `Provider "${providerId}" schedule needs at least one time window.` };
  }
  if (schedule.windows.length > 14) {
    return { error: `Provider "${providerId}" schedule allows at most 14 windows.` };
  }
  if (schedule.defaultState != null && !SCHEDULE_STATES.includes(schedule.defaultState)) {
    return { error: `Provider "${providerId}" defaultState must be "peak" or "offPeak".` };
  }
  /** @type {any[]} */
  const windows = [];
  for (const [i, w] of schedule.windows.entries()) {
    if (!isPlainObject(w)) {
      return { error: `Provider "${providerId}" window ${i + 1} must be an object.` };
    }
    if (w.type !== "peak" && w.type !== "offPeak") {
      return { error: `Provider "${providerId}" window ${i + 1} type must be "peak" or "offPeak".` };
    }
    if (!TIME_RE.test(String(w.start || "")) || !TIME_RE.test(String(w.end || ""))) {
      return { error: `Provider "${providerId}" window ${i + 1} start/end must be HH:MM (24h).` };
    }
    if (w.start === w.end) {
      return { error: `Provider "${providerId}" window ${i + 1} start and end must differ.` };
    }
    let days = SCHEDULE_DAY_LABELS;
    if (w.days !== undefined) {
      if (!Array.isArray(w.days) || !w.days.length || !w.days.every((/** @type {string} */ d) => DAY_SET.has(d))) {
        return { error: `Provider "${providerId}" window ${i + 1} days must be a non-empty subset of ${SCHEDULE_DAY_LABELS.join(", ")}.` };
      }
      days = [...new Set(w.days)].sort((a, b) => SCHEDULE_DAY_LABELS.indexOf(a) - SCHEDULE_DAY_LABELS.indexOf(b));
    }
    windows.push({ type: w.type, start: w.start, end: w.end, days });
  }
  return {
    value: {
      timezone: canonicalTimezone,
      defaultState: schedule.defaultState === "peak" ? "peak" : "offPeak",
      windows,
    },
  };
}

/**
 * Validate and normalize a modelAvailability map ("always" entries dropped).
 * Keys are combo-member strings: `provider/model` ids for LLM/media combos,
 * bare provider ids for webSearch/webFetch combos. Slashless keys (including
 * nested-combo names used as members) are harmless at runtime — they simply
 * never match a schedule and stay dormant.
 * @param {any} map
 * @returns {{ error: string } | { value: Record<string, string> }}
 */
export function normalizeModelAvailability(map) {
  if (map == null) return { value: {} };
  if (!isPlainObject(map)) {
    return { error: "modelAvailability must be an object mapping combo members to an availability rule." };
  }
  /** @type {Record<string, string>} */
  const value = {};
  for (const [model, rule] of Object.entries(map)) {
    if (!model || typeof model !== "string" || model === "__proto__" || model === "constructor" || model === "prototype") {
      return { error: `modelAvailability key "${model}" is not a valid combo member.` };
    }
    if (typeof rule !== "string" || !AVAILABILITY_SET.has(rule)) {
      return { error: `modelAvailability["${model}"] must be one of: ${AVAILABILITY_VALUES.join(", ")}.` };
    }
    if (rule !== "always") value[model] = rule;
  }
  return { value };
}

/**
 * Storage-shape variant: null value means "no rules — drop the field entirely".
 * Shared by the settings PATCH route and comboWrites so both persist identically.
 * @param {any} map
 * @returns {{ error: string } | { value: Record<string, string> | null }}
 */
export function normalizeModelAvailabilityForStorage(map) {
  const normalized = normalizeModelAvailability(map);
  if (normalized.error) return normalized;
  const entries = Object.keys(normalized.value);
  return { value: entries.length ? normalized.value : null };
}

/**
 * "3 min" / "3h 12m" countdown, shared by the 503 message and the dashboard
 * live badges so both render identical strings.
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * Rules whose provider has no schedule configured (dormant). Used for the
 * dashboard warning; runtime fail-opens these to "always".
 * @param {Record<string, any>} providerSchedules
 * @param {Record<string, string>} modelAvailability
 * @returns {string[]}
 */
export function dormantAvailabilityModels(providerSchedules, modelAvailability) {
  if (!modelAvailability) return [];
  return Object.keys(modelAvailability).filter((model) => {
    const schedule = providerSchedules?.[providerOfModel(model)];
    return getScheduleStatus(schedule) === "unscheduled";
  });
}
