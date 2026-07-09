# Database Schema

Migration: `002-routing-auto` (SQLite)

## `routing_events`

One **attempt** row per worker tried on an Auto-routed chat. A fallback chain
writes multiple rows that share `requestId`. Request-level metrics use
`COUNT(DISTINCT requestId)` or `meta.terminal = true` (one terminal row per chat:
the winner, or the last failure when everything fails).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `timestamp` | TEXT ISO | |
| `comboName` | TEXT | |
| `sessionId` | TEXT | Conversation/session key |
| `requestId` | TEXT | UUID grouping all attempts from one chat |
| `requestFingerprint` | TEXT | Hash of cluster features |
| `cluster` | TEXT | e.g. `refactor`, `debug`, `quick_edit` |
| `routerModel` | TEXT | |
| `pickedWorker` | TEXT | Worker this row attributes to |
| `alternates` | TEXT JSON | Ranked list |
| `routerReason` | TEXT | |
| `routerConfidence` | TEXT | `high` \| `low` |
| `routerLatencyMs` | INTEGER | |
| `workerStatus` | INTEGER | HTTP status |
| `workerLatencyMs` | INTEGER | |
| `fallbackUsed` | INTEGER 0/1 | **Request-level:** 1 if this chat used any fallback/rescue (prior worker failed). Not “this worker retried”. Recompute outcome with `meta.scoreFallbackUsed` / scoring inputs, not this column alone. |
| `retries` | INTEGER | Attempt index within the chain for this row |
| `tokensIn` | INTEGER | |
| `tokensOut` | INTEGER | |
| `outcomeScore` | REAL | 0–100 (per-worker attribution; rescuer scored clean) |
| `objective` | TEXT | Snapshot at route time |
| `learningVersionId` | TEXT | FK |
| `meta` | TEXT JSON | `terminal`, `requestId`, `exploration`, `skippedRouter`, `scoreFallbackUsed`, `attempts[]`, tools/vision flags |

**Indexes:**

- `(comboName, timestamp DESC)`
- `(cluster, comboName)`
- `(pickedWorker)`
- `(comboName, requestId)`

## `router_learning_versions`

Versioned learning artifacts per combo.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT UUID | |
| `comboName` | TEXT | |
| `version` | INTEGER | Monotonic per combo |
| `createdAt` | TEXT | |
| `source` | TEXT | `manual` \| `scheduled` \| `ab_promoted` |
| `banditTable` | TEXT JSON | See below |
| `learnedRules` | TEXT JSON | `string[]` |
| `fewShots` | TEXT JSON | See below |
| `evalScore` | REAL | |
| `prevVersionId` | TEXT | Rollback chain |
| `promoted` | INTEGER 0/1 | Only one active per combo |
| `notes` | TEXT | Optimizer summary for UI |

### `banditTable` shape

```json
{
  "refactor": {
    "model-a": { "wins": 42, "attempts": 50, "avgScore": 78.2, "p50LatencyMs": 2100 },
    "model-b": { "wins": 30, "attempts": 48, "avgScore": 71.0, "p50LatencyMs": 1800 }
  }
}
```

### `fewShots` shape

```json
[
  {
    "fingerprint": "tools+code+2k",
    "cluster": "refactor",
    "worker": "model-b",
    "score": 92,
    "summary": "Multi-file rename; sonnet succeeded in 2.1s"
  }
]
```

## `routing_feedback` (v1.1)

| Column | Type |
|--------|------|
| `routingEventId` | INTEGER FK |
| `rating` | INTEGER -1 \| 0 \| 1 |
| `createdAt` | TEXT |

## Example queries

**Win rate heatmap (attempt-level, for bandit):**

```sql
SELECT cluster, pickedWorker,
       COUNT(*) AS n,
       SUM(CASE WHEN outcomeScore >= 60 THEN 1 ELSE 0 END) AS wins,
       AVG(outcomeScore) AS avg_score
FROM routing_events
WHERE comboName = ? AND timestamp >= ?
  AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
GROUP BY cluster, pickedWorker;
```

**Request-level event count (minEvents / insights):**

```sql
SELECT COUNT(DISTINCT COALESCE(requestId, CAST(id AS TEXT))) AS n
FROM routing_events
WHERE comboName = ? AND timestamp >= ?
  AND (meta LIKE '%"terminal":true%'
       OR meta IS NULL OR meta NOT LIKE '%"terminal"%');
```

**Score trend (mean per day, full window):**

```sql
SELECT substr(timestamp,1,10) AS day, AVG(outcomeScore) AS avgScore, COUNT(*) AS n
FROM routing_events
WHERE comboName = ? AND timestamp >= ?
  AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
  AND (meta LIKE '%"terminal":true%' OR meta IS NULL OR meta NOT LIKE '%"terminal"%')
GROUP BY day ORDER BY day;
```

**Recent decisions (terminal only):**

```sql
SELECT timestamp, cluster, pickedWorker, outcomeScore, routerReason
FROM routing_events
WHERE comboName = ?
  AND (meta LIKE '%"terminal":true%' OR meta IS NULL OR meta NOT LIKE '%"terminal"%')
ORDER BY timestamp DESC
LIMIT 50;
```

## Retention

- Default: keep 90 days of `routing_events` (dashboard setting)
- Versions: keep all; user can delete old via UI (v1.1)
