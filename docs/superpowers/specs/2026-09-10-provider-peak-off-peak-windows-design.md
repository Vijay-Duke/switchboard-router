# Provider peak/off-peak windows + time-gated combo models

**Date:** 2026-09-10
**Status:** Implemented 2026-09-10 (Phases 1–3 complete; 4 review rounds per phase). Tests: `tests/unit/provider-schedule-windows.test.js`.
**Problem:** Some providers bill by time of day — DeepSeek charges 50% outside peak hours — but combos can't express "use this model only when it's cheap." A cost-optimized combo (e.g. `cheap_models`) with DeepSeek first burns peak-rate requests all day.

## Research

### Upstream reality (DeepSeek is the driver, not the only user)

Verified against `api-docs.deepseek.com/quick_start/pricing` on 2026-09-10:

- **Peak:** 01:00–04:00 UTC **and** 06:00–10:00 UTC, **Monday–Friday only**.
- **Off-peak:** everything else — weekday gaps plus the entire weekend — at half the peak rate. (Bloomberg: weekend peak pricing ended 2026-08-23.)
- The policy has already changed once: the Feb-2025 discount was a single daily off-peak window (16:30–00:30 UTC = 00:30–08:30 Beijing).

Design consequences:

1. The schedule model must support **multiple windows per day**, **day-of-week scoping**, and a **user-selected timezone** (default UTC — DeepSeek quotes UTC).
2. Windows must be **stored user config, never a hardcoded DeepSeek constant** — providers move their windows. At most we ship a fill-in preset.

### Codebase facts that shape the design

| Fact | Where | Consequence |
|---|---|---|
| Combo `models` is a JSON array of plain `"provider/model"` strings | `src/lib/db/schema.js:97-107`, `src/lib/db/repos/combosRepo.js:11` | Per-model config can't ride on the entries without changing the shape every consumer assumes |
| Per-combo strategy lives in the settings blob, guarded by `STRATEGY_ALLOWED_KEYS` (anything else is silently dropped — `strategy.filterWorker` is *invoked* as code) | `src/lib/combos/comboWrites.js:147-157`, `open-sse/routing/handleAutoChat.js:360-366` | A new `modelAvailability` key must be added to the allowlist with its own nested validation |
| Per-provider config precedent: `settings.providerStrategies[providerId]`, `settings.providerThinking[providerId]` — no migration, validated in `src/app/api/settings/route.js` (`findInvalidAccountScheduler`, lines 50-72) | `src/lib/db/repos/settingsRepo.js:7-51` | A `settings.providerSchedules[providerId]` map follows the exact same pattern |
| Settings are re-read per request through a 2s memo (`SETTINGS_CACHE_TTL_MS`) — `providerThinking` already rides this path | `settingsRepo.js:69-111`, `src/sse/handlers/chat.js:807-808` | Schedule checks are fresh to ≤2s; window edges are minute-scale, so this is fine |
| Candidate ordering for fallback/round-robin: `getRotatedModels` → capability reorder → provider ordering, then a sequential attempt loop | `open-sse/services/combo.js:371-434` | Filter **before** rotation so skipped models don't consume rotation slots |
| Auto: pool built in `buildWorkerPool` (already has a `filterWorker` hook); router prompt, 10-min cached routes, bandit picks, and failure-chain full-pool fallback all derive from that pool and are guarded by `candidates.includes(...)` | `handleAutoChat.js:360-366, 378-429, 525-717, 1294-1366` | Filtering `workerModels` in `chat.js:384-388` covers the whole Auto path, including a cached route that goes stale at a window boundary |
| Fusion: `panel = models.filter(Boolean)` then parallel fan-out | `open-sse/services/combo.js:952-1022` | Filter the `models` input before `handleFusionChat` |
| Nested combos re-expand models in `handleSingleModelChat` | `src/sse/handlers/chat.js:554-728` | The filter must be a shared helper applied at both expansion sites, plus the capacity-adapter injection at `chat.js:432-441` |
| `disabledModels` (kv scope) hides models from catalogs but is **not enforced on the request path** | `src/lib/db/repos/disabledModelsRepo.js`, consumers in `src/app/api/*/models/*` | This feature is the opposite shape: a **request-path routing gate**; gated models stay visible in `/v1/models` |
| No timezone/schedule/cron infrastructure exists; tz appears only in outbound identity spoofing and display formatting | `open-sse/utils/cursorChecksum.js:137`, dashboard `toLocale*` call sites | The evaluator is new, dependency-free `Intl.DateTimeFormat(timeZone)` code |

## Design

Two user-visible concepts, both optional and dormant until configured:

1. **Provider schedule** — peak/off-peak hours for a provider, in a user-chosen timezone.
2. **Model availability in a combo** — per-entry rule: `always` (default) / `peak-only` / `off-peak-only`.

### Data shapes

`settings.providerSchedules[providerId]` (settings blob, keyed like `providerStrategies`):

```jsonc
{
  "timezone": "UTC",              // IANA zone, default "UTC"
  "defaultState": "offPeak",      // what unlisted time is: "offPeak" | "peak"
  "windows": [
    { "type": "peak", "start": "01:00", "end": "04:00", "days": ["mon","tue","wed","thu","fri"] },
    { "type": "peak", "start": "06:00", "end": "10:00", "days": ["mon","tue","wed","thu","fri"] }
  ]
}
```

- **Status of "now"** = type of the **first** window whose day matches and whose span contains now (spans may cross midnight: `start > end` wraps); otherwise `defaultState`. Absent schedule ⇒ `unscheduled`.
- `defaultState` supports both mental models: DeepSeek today (peak is the exception → `defaultState: "offPeak"` + peak windows) and DeepSeek-Feb-2025 (the discount is the exception → `defaultState: "peak"` + one `offPeak` window). No complement math, no ambiguity.
- `days` defaults to all seven; this is what makes "weekends always off-peak" expressible.

`settings.comboStrategies[comboName].modelAvailability` (same strategy blob the combo editor already saves):

```jsonc
{ "deepseek/deepseek-chat": "off-peak-only" }   // "always" | "peak-only" | "off-peak-only"
```

- Only non-`always` entries are stored; unlisted models are always eligible.
- Keys are canonical `provider/model` ids present in the combo (nested-combo names are rejected as keys); keys not in the combo's models are pruned on save.

**Rejected alternatives:** storing the schedule on `providerConnections.data` (a provider with multiple accounts would need N copies that drift); changing combo `models` entries to objects (every consumer — rotation, caps resolver, `/v1/models`, cycle walker, `ModelItem` UI, tests — assumes strings; the sidecar map is additive and preserves per-combo semantics, since the same model may be `off-peak-only` in `cheap_models` and unrestricted elsewhere).

### Evaluation

New dependency-free module in `src/shared/` (used by both the request path and the dashboard for live badges):

```js
getScheduleStatus(schedule, nowMs)            // → "peak" | "offPeak" | "unscheduled"
filterModelsByAvailability(models, providerSchedules, modelAvailability, nowMs)
// → { models, skipped: [{ model, provider, availability, status, untilMs }] }
```

- `Intl.DateTimeFormat(..., { timeZone, weekday, hour, minute, hour12: false })` gives wall-clock now in the schedule's zone — DST-correct by construction (a 01:00–04:00 window in `America/New_York` shifts its UTC instant at spring-forward; that is the correct reading of "provider defines hours in that zone").
- Memoize per minute: all models of one provider share a status; one `Map<provider, status>` per request, not per model.
- `untilMs` (next transition) is computed by scanning windows for the earliest boundary after now — used for the 503 `retry-after` and the UI status line.

### Enforcement (request path)

Filter once, in `src/sse/handlers/chat.js`, right after `getComboModels`/`augmentModelsWithCapacityAdapter` — `open-sse` stays config-driven via parameters and never learns about schedules:

| Path | Site | Behavior |
|---|---|---|
| fallback / round-robin | filter `models` before `handleComboChat` (i.e. before `getRotatedModels`, `combo.js:372`) | Skipped models never consume rotation slots; attempt order starts at the first eligible model |
| fusion | filter `models` before `handleFusionChat` | Panel is built from eligible models only |
| auto | filter `workerModels` at `chat.js:384-388` | `buildWorkerPool` → router prompt, cached routes, bandit picks, escalation and full-pool failure chain all inherit the filtered pool (`candidates.includes` guards already cover stale cached picks at window boundaries) |
| nested combos | same helper at the expansion in `handleSingleModelChat` (`chat.js:554-728`) | Applied recursively; nesting cap unchanged |
| media + web combos | gate at expansion in `tts.js`, `imageGeneration.js`, `search.js`, `fetch.js` | Same contract; STT/video/embeddings have no combo expansion today |
| capacity adapter | runs AFTER the gate on the already-filtered list | Injected adapter models are not combo members, so they can never carry availability rules (rules are pruned to members on every write) — nothing to filter |
| direct model request (no combo) | **not gated** | A request naming `deepseek/deepseek-chat` directly is explicit user intent — gating is a combo-routing concept |

**All models gated out ⇒ fail-closed 503** with `retry-after` = seconds to the next allowed window, naming each skipped model and its rule (e.g. *"all models in combo `cheap_models` are outside their allowed hours; deepseek/deepseek-chat is off-peak-only, DeepSeek is peak until 04:00 UTC"*). Fail-open would silently double the bill, which is exactly what this feature exists to prevent. The escape hatch is documented in the error/UI: flip the entry to *Always*.

Each skip is both logged (`COMBO`/`AUTO`: `skipped deepseek/deepseek-chat (off-peak-only; provider peak until 04:00 UTC)`) **and persisted on the request's routing event** as `meta.scheduleSkips = [{ model, provider, availability, status, until }]` — the `routing_events.meta` JSON column (`src/lib/db/schema.js:247`) already exists and the insights page already renders per-event `meta` badges (`e.meta?.exploration`, `e.meta?.judgeScore`, `src/app/(dashboard)/dashboard/combos/routing/page.js:763-776`), so skip reasons surface in **Combos → Routing insights** as a badge on each affected request without a new table.

*Implementation notes:* routing events are only written by the Auto path today (fallback/round-robin/fusion never write `routing_events`), so insights badges are Auto-only; skips on the other strategies are covered by log lines and the 503 message. The settings API merges `providerSchedules` **incrementally** (incoming keys win, explicit `null` deletes that provider, absent keys keep their stored value) so a partial PATCH from one provider page can never wipe another provider's schedule. Schedules are keyed by the **model-string prefix** — for custom compatible nodes that is the node prefix, not its internal id — matching what the request-path lookup uses.

### API + validation

- `PATCH /api/settings`: add `findInvalidProviderSchedules` next to `findInvalidAccountScheduler` (`src/app/api/settings/route.js:50-72`): timezone must construct a valid `Intl.DateTimeFormat` (try/catch `RangeError`); `start`/`end` strict `HH:MM` and `start !== end`; `days` ⊆ 7 known labels; `windows.length ≤ 14`; `modelAvailability` values ∈ enum, keys non-empty strings.
- `STRATEGY_ALLOWED_KEYS` (`comboWrites.js:150`) gains `modelAvailability`, validated in `sanitizeStrategyInput` (value enum + prune-to-combo-models) — without this the key is **silently dropped** today.
- No DB migration anywhere: settings blob only.

### Dashboard

- **Provider detail page** — new "Peak hours" card (toggle → timezone select → window rows `[type][start][end][days-chips]` → add/remove row), plus a live status line *"Currently off-peak — next peak Mon 01:00 UTC (in 3h 12m)"* computed client-side by the shared evaluator. A **"DeepSeek (current)" preset** fills the two weekday windows above; it's a convenience, the stored config is explicit. Saves go through `PATCH /api/settings` using the `patchProviderStrategy` queue pattern (`src/shared/utils/providerStrategySettings.js`).
- **Combos page** — in `ModelItem` (`CombosPageClient.js:944-1058`), a per-row availability dropdown (*Always / Peak only / Off-peak only*) shown only when the entry's provider has a schedule; otherwise the control is disabled with the hint *"Set peak hours on the <provider> page first"*. Persisted with the rest of the combo strategy. A live 🟢/🔴 dot per scheduled provider in the combo list.
- Timezone picker: curated common zones + `UTC (default)` + the machine-local zone, native `Select.js` (no search). A full IANA `<datalist>` search is optional polish — no such primitive exists today.

### Edge semantics (decided, flag if you disagree)

1. **Entry is `peak-only`/`off-peak-only` but its provider has no schedule** → treated as `always` (fail-open) at runtime; the UI prevents creating this state and shows a warning if a schedule is deleted while rules reference it. A misconfigured provider shouldn't brick a combo.
2. **All gated out** → fail-closed 503 (above).
3. **Direct model requests** → never gated (above).
4. **Learning/Auto stats** — a gated model simply receives no traffic during gated hours; its 7-day win-rate in the router prompt reflects allowed hours only. No stats surgery.
5. **Catalog** — gated models remain in `/v1/models` and `/v1/models/info` (this is routing, not availability). Phase-3: `/v1/models/info?id=…` annotates the model with `schedule: { status: "peak"|"offPeak", nextChange: ISO|null, timezone, defaultState, windows[] }` when the id's provider prefix has a schedule. The key is the model-string prefix (same as the request-path gate), so combo names never annotate. `/v1` is an intentionally public prefix in this deployment (the model catalog is already served unauthenticated there); schedules describe published provider pricing policies, so this is the same sensitivity class as the catalog — if the deployment wants it hidden, the endpoint needs an auth gate as a whole, not just this field.

## Testing

- Evaluator units (`tests/unit/`): midnight-crossing span, multi-window first-match, weekday scoping incl. weekend-all-off-peak, tz conversion, DST spring-forward in `America/New_York`, invalid zone, `defaultState` fallback, `untilMs` at boundaries.
- Routing units: fallback falls from gated model #1 to #2; rotation slot not consumed by a skip; fusion panel filtered; Auto pool excludes gated model and stale cached route is refused; all-gated 503 with `retry-after`. (Capacity-adapter injections can't carry rules — they're never combo members — so there is no injection case to test.)
- Validation units: settings validator matrix; `sanitizeStrategyInput` keeps/drops `modelAvailability`; pruning of stale keys.
- Regression gate: `tests/__baseline__/verify-no-regression.mjs` — no new fails.

## Phasing

1. **Phase 1 (engine):** evaluator, `providerSchedules` + `modelAvailability` storage with validation, request-path filtering for fallback/round-robin/auto/fusion/nested, 503 semantics, logs + `meta.scheduleSkips` persisted on routing events.
2. **Phase 2 (UI):** provider Peak-hours card + preset, combo per-model dropdown, live status badges, routing-insights skip badges.
3. **Phase 3 (optional):** IANA-search picker, `/v1/models/info` schedule metadata, media combos (stt/tts/image), a small presets library for other time-priced providers.

All three phases shipped 2026-09-10. Media coverage: TTS and image-generation combos gate at expansion (`src/sse/handlers/tts.js`, `imageGeneration.js`); STT and video have no combo expansion today, so there is nothing to gate. Media combos run fallback/round-robin only (no Auto), so skip reasons surface via logs and the 503 body, not routing events. The per-model availability dropdown ships in the LLM combos editor; for media combos the same `modelAvailability` strategy blob is honored at runtime and can be set via the settings API.

Rollout is inherently safe: with no schedules configured, every lookup returns `unscheduled`, no model is filtered, and behavior is byte-identical to today.

## Decisions (resolved 2026-09-10)

1. **All models gated out ⇒ fail-closed 503** with `retry-after` = next allowed window. Confirmed acceptable.
2. **Availability is per-combo-per-model** (`comboStrategies[combo].modelAvailability`), not a global per-model rule — the same model can be `off-peak-only` in `cheap_models` and unrestricted in another combo.
3. **Schedule deleted while rules still reference the provider ⇒ rules stay dormant-but-warned.** Runtime treats `peak-only`/`off-peak-only` with no schedule as `always` (fail-open); the dashboard shows a persistent warning on the combo listing every dormant rule until the schedule is restored or the rule flipped back to *Always*.
4. **Skip reasons surface in routing insights.** Persisted as `routing_events.meta.scheduleSkips` (Phase 1) and rendered as badges on affected requests in Combos → Routing insights (Phase 2), following the existing `meta.exploration` / `meta.judgeScore` badge pattern.
