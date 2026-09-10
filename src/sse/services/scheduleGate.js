// @ts-check
/**
 * Request-path glue for provider peak/off-peak windows + per-combo model
 * availability rules (design: docs/superpowers/specs/2026-09-10-...-design.md).
 *
 * Pure evaluation lives in `@/shared/utils/scheduleWindows.js`; this module
 * binds it to the request settings, logs skips, builds the fail-closed 503
 * when a whole combo is gated out, and wraps `recordEvent` so Auto routing
 * events carry `meta.scheduleSkips` for the routing-insights UI.
 */
import {
  filterModelsByAvailability,
  formatCountdown,
} from "@/shared/utils/scheduleWindows.js";
import { unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

/**
 * Fail-closed 503 for a combo with no eligible members right now. `skipped`
 * carries the rules and next-eligible instants; Retry-After is the earliest.
 * @param {{ comboName: string, skipped: Array<object>, log?: object }} input
 * @returns {Response}
 */
export function buildScheduleBlockedResponse({ comboName, skipped, log }) {
  const retryAfterMs = Math.min(...skipped.map((s) => s.untilMs));
  const waitMs = Math.max(retryAfterMs - Date.now(), 60_000);
  const detail = skipped
    .map((s) => `${s.model} (${s.availability}; ${s.provider} is ${s.status === "peak" ? "peak" : "off-peak"})`)
    .join("; ");
  const message =
    `Combo "${comboName}": all models are outside their allowed hours — ${detail}. ` +
    `Set a member to "Any time" in the combo editor to allow it regardless of schedule.`;
  // log.warn is a no-op in src/sse/utils/logger.js — info actually prints.
  log?.info?.("SCHEDULE", `BLOCKED ${message} (retry in ${formatCountdown(waitMs)})`);
  return unavailableResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    message,
    new Date(Date.now() + waitMs),
    `next eligible model in ${formatCountdown(waitMs)}`
  );
}

/**
 * Filter a combo's models by per-model availability rules. Zero-cost when the
 * combo has no rules configured. `nowMs` pins the evaluation instant
 * (tests pass a fixed timestamp; production uses the real clock).
 * @param {{ models: string[], comboName: string, settings: object, log?: object, nowMs?: number }} input
 * @returns {{ models: string[], skipped: Array<object>, blocked: boolean, response: Response|null }}
 */
export function applyScheduleGate({ models, comboName, settings, log, nowMs }) {
  const availability = settings?.comboStrategies?.[comboName]?.modelAvailability;
  if (
    !Array.isArray(models) || !models.length ||
    !availability || typeof availability !== "object" ||
    !Object.keys(availability).length
  ) {
    return { models, skipped: [], blocked: false, response: null };
  }
  const schedules = settings?.providerSchedules || {};
  const { models: kept, skipped } = filterModelsByAvailability(
    models,
    schedules,
    availability,
    nowMs,
  );

  for (const skip of skipped) {
    const until = new Date(skip.untilMs).toISOString();
    log?.info?.(
      "SCHEDULE",
      `skipped ${skip.model} (${skip.availability}; ${skip.provider} is ${skip.status === "peak" ? "peak" : "off-peak"} until ${until})`
    );
  }

  if (!kept.length && skipped.length) {
    return {
      models: [],
      skipped,
      blocked: true,
      response: buildScheduleBlockedResponse({ comboName, skipped, log }),
    };
  }

  return { models: kept, skipped, blocked: false, response: null };
}

/**
 * Wrap a routing-event recorder so the first event of this request carries the
 * schedule skips (`meta.scheduleSkips`) for Combos → Routing insights.
 * @param {(ev: object) => any} record
 * @param {Array<object>} skipped
 * @returns {(ev: object) => any}
 */
export function attachScheduleSkips(record, skipped) {
  if (!Array.isArray(skipped) || !skipped.length) return record;
  let attached = false;
  return (ev) => {
    if (!attached) {
      attached = true;
      ev = {
        ...ev,
        meta: {
          ...(ev?.meta || {}),
          scheduleSkips: skipped.map((s) => ({
            model: s.model,
            provider: s.provider,
            availability: s.availability,
            status: s.status,
            until: new Date(s.untilMs).toISOString(),
          })),
        },
      };
    }
    return record(ev);
  };
}
