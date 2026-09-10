// @ts-check
"use client";
/**
 * Peak / off-peak hours editor for one provider.
 *
 * Optional per-provider schedule stored at `settings.providerSchedules[providerId]`
 * (design: docs/superpowers/specs/2026-09-10-provider-peak-off-peak-windows-design.md).
 * Combos can then mark individual models peak-only / off-peak-only. Saving is a
 * GET-then-PATCH of the providerSchedules map so concurrent edits of other
 * providers are preserved.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Card, Button, Select, Toggle } from "@/shared/components";
import {
  SCHEDULE_DAY_LABELS,
  SCHEDULE_PRESETS,
  formatCountdown,
  getScheduleStatus,
  nextTransitionMs,
  normalizeScheduleConfig,
} from "@/shared/utils/scheduleWindows.js";

// Favorites first, then every IANA zone the platform knows. The picker is a
// datalist (type to search), so ordering only affects the empty-state list.
const CURATED_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
];
const ALL_TIMEZONES = (() => {
  /** @type {string[]} */
  let zones = [];
  try {
    // Node ≥18 and modern browsers; older runtimes fall back to curated only.
    zones = /** @type {string[]} */ (Intl.supportedValuesOf?.("timeZone") || []);
  } catch {
    zones = [];
  }
  try {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local && !CURATED_TIMEZONES.includes(local)) CURATED_TIMEZONES.unshift(local);
  } catch { /* ignore */ }
  return [...new Set([...CURATED_TIMEZONES, ...zones.filter((z) => !CURATED_TIMEZONES.includes(z))])];
})();

const DAY_SHORT = { mon: "Mo", tue: "Tu", wed: "We", thu: "Th", fri: "Fr", sat: "Sa", sun: "Su" };

/**
 * @param {string} iso
 * @returns {string} e.g. "Mon 04:00"
 */
function formatBoundary(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function countdown(targetMs) {
  return formatCountdown(targetMs - Date.now());
}

/**
 * @param {{ providerId: string, scheduleKey?: string }} props
 * `scheduleKey` is the key schedules are stored and looked up by at request
 * time — the model-string prefix. For registry providers that equals the
 * provider's UI alias (e.g. "ds" for deepseek, NOT its internal id); for
 * custom compatible nodes it is the node's user-defined prefix.
 */
export default function PeakHoursCard({ providerId, scheduleKey }) {
  const key = scheduleKey || providerId;
  const timezoneListId = useId();
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [timezone, setTimezone] = useState("UTC");
  const [defaultState, setDefaultState] = useState("offPeak");
  const [windows, setWindows] = useState(/** @type {any[]} */ ([]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState(0);
  const [, forceTick] = useState(0);

  const applyPreset = useCallback((presetId) => {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setTimezone(preset.config.timezone || "UTC");
    setDefaultState(preset.config.defaultState === "peak" ? "peak" : "offPeak");
    setWindows(preset.config.windows.map((w) => ({
      type: w.type,
      start: w.start,
      end: w.end,
      days: Array.isArray(w.days) && w.days.length ? [...w.days] : [...SCHEDULE_DAY_LABELS],
    })));
    setSavedAt(0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Reset first: provider soft-navigation reuses this component, and a
    // missing config must not leave the previous provider's editor state
    // rendered (let alone saved under the new key).
    setEnabled(false);
    setTimezone("UTC");
    setDefaultState("offPeak");
    setWindows([]);
    setSavedAt(0);
    setError("");
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => {
        if (cancelled) return;
        const cfg = (data.providerSchedules || {})[key];
        if (cfg && Array.isArray(cfg.windows) && cfg.windows.length) {
          setEnabled(true);
          setTimezone(cfg.timezone || "UTC");
          setDefaultState(cfg.defaultState === "peak" ? "peak" : "offPeak");
          setWindows(cfg.windows.map((/** @type {any} */ w) => ({
            type: w.type === "offPeak" ? "offPeak" : "peak",
            start: w.start || "09:00",
            end: w.end || "17:00",
            days: Array.isArray(w.days) && w.days.length ? [...w.days] : [...SCHEDULE_DAY_LABELS],
          })));
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [key]);

  // Live status refresh
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const liveSchedule = useMemo(
    () => (enabled ? { timezone, defaultState, windows } : null),
    [enabled, timezone, defaultState, windows]
  );
  const status = getScheduleStatus(liveSchedule);
  const nextAt = status === "unscheduled" ? null : nextTransitionMs(liveSchedule);

  const updateWindow = useCallback((index, patch) => {
    setWindows((prev) => prev.map((w, i) => (i === index ? { ...w, ...patch } : w)));
    setSavedAt(0);
  }, []);

  const toggleDay = useCallback((index, day) => {
    setWindows((prev) => prev.map((w, i) => {
      if (i !== index) return w;
      const days = w.days.includes(day)
        ? w.days.filter((/** @type {string} */ d) => d !== day)
        : [...w.days, day];
      return { ...w, days: days.length ? days : w.days };
    }));
    setSavedAt(0);
  }, []);

  const handleSave = async () => {
    setError("");
    const normalized = enabled
      ? normalizeScheduleConfig({ timezone, defaultState, windows }, providerId)
      : null;
    if (enabled && normalized.error) {
      setError(normalized.error);
      return;
    }
    setSaving(true);
    try {
      // The settings route merges this key incrementally (incoming keys win,
      // null deletes, absent keys keep their stored value), so a partial
      // payload here can never clobber another provider's schedule.
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerSchedules: { [key]: enabled ? normalized.value : null } }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || `Failed to save peak hours (${res.status})`);
        return;
      }
      setSavedAt(Date.now());
    } catch {
      setError("Failed to save peak hours");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Peak hours</h2>
          {status !== "unscheduled" && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                status === "peak"
                  ? "bg-red-500/10 text-red-600 dark:text-red-400"
                  : "bg-green-500/10 text-green-600 dark:text-green-400"
              }`}
              title={nextAt ? `Changes at ${formatBoundary(new Date(nextAt).toISOString(), timezone)}` : undefined}
            >
              <span className={`size-1.5 rounded-full ${status === "peak" ? "bg-red-500" : "bg-green-500"}`} />
              {status === "peak" ? "Peak now" : "Off-peak now"}
              {nextAt ? ` · ${countdown(nextAt)} left` : ""}
            </span>
          )}
        </div>
        <Toggle
          checked={enabled}
          onChange={(next) => {
            setEnabled(next);
            setSavedAt(0);
            if (next && !windows.length) {
              setTimezone("UTC");
              setDefaultState("offPeak");
              setWindows([{ type: "peak", start: "09:00", end: "17:00", days: [...SCHEDULE_DAY_LABELS] }]);
            }
          }}
          label="Enable peak / off-peak hours"
          size="sm"
        />
      </div>

      <p className="mb-3 text-xs text-text-muted leading-relaxed">
        Optional. Some providers (e.g. DeepSeek) charge less outside peak hours.
        Define this provider&apos;s windows once, then mark models in a combo as
        peak-only or off-peak-only to skip them at the wrong hours.
      </p>

      {enabled && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={timezoneListId} className="text-sm font-medium text-text-main">
                Timezone
              </label>
              <input
                id={timezoneListId}
                list={`${timezoneListId}-zones`}
                value={timezone}
                onChange={(e) => { setTimezone(e.target.value); setSavedAt(0); }}
                placeholder="UTC — type to search IANA zones"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
                autoComplete="off"
              />
              <datalist id={`${timezoneListId}-zones`}>
                {ALL_TIMEZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              <p className="text-[10px] text-text-muted">
                Windows are wall-clock in this zone (provider docs usually quote UTC)
              </p>
            </div>
            <Select
              label="Outside all windows is"
              options={[
                { value: "offPeak", label: "Off-peak (peak is the exception)" },
                { value: "peak", label: "Peak (off-peak discount is the exception)" },
              ]}
              value={defaultState}
              onChange={(e) => { setDefaultState(e.target.value); setSavedAt(0); }}
            />
          </div>

          <Select
            label="Load a preset"
            options={SCHEDULE_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            value=""
            onChange={(e) => applyPreset(e.target.value)}
            placeholder="Choose a known provider policy…"
            hint="Fills the editor below — review the provider's current pricing page, then Save"
          />

          <div className="flex flex-col gap-2">
            {windows.map((w, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-black/[0.02] px-2 py-2 dark:bg-white/[0.02]"
              >
                <select
                  value={w.type}
                  onChange={(e) => updateWindow(i, { type: e.target.value })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                  aria-label={`Window ${i + 1} type`}
                >
                  <option value="peak">Peak</option>
                  <option value="offPeak">Off-peak</option>
                </select>
                <input
                  type="time"
                  value={w.start}
                  onChange={(e) => updateWindow(i, { start: e.target.value })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                  aria-label={`Window ${i + 1} start`}
                />
                <span className="text-xs text-text-muted">→</span>
                <input
                  type="time"
                  value={w.end}
                  onChange={(e) => updateWindow(i, { end: e.target.value })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                  aria-label={`Window ${i + 1} end`}
                />
                <div className="flex items-center gap-1">
                  {SCHEDULE_DAY_LABELS.map((day) => (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleDay(i, day)}
                      className={`size-6 rounded text-[10px] font-medium transition-colors ${
                        w.days.includes(day)
                          ? "bg-primary/15 text-primary"
                          : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"
                      }`}
                      title={day}
                    >
                      {DAY_SHORT[day]}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setWindows((prev) => prev.filter((_, idx) => idx !== i));
                    setSavedAt(0);
                  }}
                  className="ml-auto rounded p-1 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
                  title="Remove window"
                  aria-label={`Remove window ${i + 1}`}
                >
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon="add"
                onClick={() => {
                  setWindows((prev) => [
                    ...prev,
                    { type: "peak", start: "09:00", end: "17:00", days: [...SCHEDULE_DAY_LABELS] },
                  ]);
                  setSavedAt(0);
                }}
              >
                Add window
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      {savedAt > 0 && !error && <p className="mt-2 text-xs text-green-600 dark:text-green-400">Saved</p>}

      <div className="mt-3">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : enabled ? "Save peak hours" : "Save (disable schedule)"}
        </Button>
      </div>
    </Card>
  );
}
