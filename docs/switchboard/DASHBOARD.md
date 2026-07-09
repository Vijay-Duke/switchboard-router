# Dashboard Specification

All configuration and operations happen in the web dashboard. No CLI, no `config.toml` editing, no `agents sync`.

## Combos page — Auto strategy block

When `strategy === "auto"`, show:

### Router

- **Router model** dropdown (from connected providers)
- Default: `claude-opus-4-8`
- Warning if router is also in worker pool (auto-exclude)

### Worker pool

- Same multi-select as other strategies
- Router model excluded from pool display

### Objective

| Value | Router bias |
|-------|-------------|
| Quality | Prefer highest win-rate / reasoning models |
| Balanced | Default |
| Economy | Prefer cheaper when scores within 10% |
| Latency | Prefer lowest p50 latency |

### Learning controls

| Control | Type | Default |
|---------|------|---------|
| Enable learning | toggle | on |
| Learning window | 7 / 14 / 30 days | 14 |
| Exploration rate | slider 0–20% | 5% |
| Auto-relearn interval | off / 6h / 12h / 24h / 72h | 24h |
| Freeze learning | toggle | off |
| **Relearn now** | button | — |
| Active version | read-only + history link | — |

### Status line

Examples:

- `Learning v4 active · last relearn 2h ago · 1,240 events`
- `Need 23 more requests before first learn (min 50)`

## Routing Insights page

**Route:** `/dashboard/combos/[name]/routing` or tab on combo detail.

### Sections

1. **Win rate heatmap** — cluster × worker, color by avg outcomeScore
2. **Recent decisions** — table: time, cluster, worker, score, reason, latencies
3. **Model performance** — bar chart: avg score, p50 latency, 429 rate
4. **Learning versions** — version, eval score, promoted badge, Promote / Rollback
5. **Exploration log** — requests where epsilon-greedy picked random worker

### Filters

- Date range (`days=7|14|30|90`)
- Cluster
- Worker model
- Exploration-only toggle

### Metrics notes

- **Requests / eventCount** are request-level (`terminal` / `DISTINCT requestId`), aligned with the min-events learn gate.
- Intermediate fallback attempt rows still feed the bandit heatmap; they do not inflate the request count.
- Single-worker and heuristic shortcuts intentionally skip logging (no bandit poison) — status lines understate that traffic.

### Score trend

Mean `outcomeScore` per calendar day over the selected window (SQL `GROUP BY day`, not last-N-row truncated).

## API routes

### `POST /api/routing/learn`

```json
{ "comboName": "auto", "force": true }
```

Response:

```json
{
  "ok": true,
  "promoted": true,
  "version": 5,
  "evalScore": 74.8,
  "prevEvalScore": 71.2,
  "message": "Promoted v5"
}
```

### `GET /api/routing/insights?combo=auto&days=14`

```json
{
  "heatmap": [...],
  "recent": [...],
  "modelStats": [...],
  "versions": [...],
  "eventCount": 1240,
  "attemptCount": 1580,
  "scoreTrend": [{ "day": "2026-07-01", "avgScore": 72.4, "n": 40 }],
  "minEventsBeforeLearn": 50
}
```

### `POST /api/routing/versions/promote`

```json
{ "comboName": "auto", "versionId": "uuid" }
```

### `POST /api/routing/versions/rollback`

```json
{ "comboName": "auto" }
```

Rolls back to `prevVersionId` of current promoted version.

### `POST /api/routing/feedback` (v1.1)

```json
{ "routingEventId": 12345, "rating": 1 }
```

## Settings persistence

Stored in app settings JSON (or dedicated columns):

```json
{
  "comboStrategies": {
    "auto": {
      "fallbackStrategy": "auto",
      "routerModel": "claude-opus-4-8",
      "objective": "balanced",
      "routeEveryTurn": true,
      "learningEnabled": true,
      "learningWindowDays": 14,
      "explorationRate": 0.05,
      "autoLearnIntervalHours": 24,
      "freezeLearning": false,
      "activeLearningVersionId": "uuid-v4"
    }
  }
}
```

## UX principles

- **Fail-open:** learning errors show toast, never block chat
- **Transparency:** every route shows worker + reason in insights
- **One-click rollback:** no confirmation maze for version revert
- **Progressive disclosure:** advanced tuning under “Advanced” collapse

## Wireframe (ASCII)

```
┌─ Combo: auto ─────────────────────────────────────┐
│ Strategy: [Auto ▼]                                 │
│                                                    │
│ Router model:  [claude-opus-4-8        ▼]         │
│ Workers:       [☑ fast] [☑ balanced] [☑ reasoning]│
│ Objective:     ( ) Quality (•) Balanced ( ) Economy│
│                                                    │
│ Learning  [ON]  Window: [14d ▼]  Explore: [5%]    │
│ Auto-relearn: [Every 24h ▼]   [Relearn now]        │
│ Active: v4 (eval 74.8)  [View history]             │
│                                                    │
│ [Routing Insights →]                               │
└────────────────────────────────────────────────────┘
```
