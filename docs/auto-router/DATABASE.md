# Database Schema

Migration: `002-routing-auto` (SQLite)

## `routing_events`

One row per Auto-routed request.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `timestamp` | TEXT ISO | |
| `comboName` | TEXT | |
| `sessionId` | TEXT | Conversation/session key |
| `requestFingerprint` | TEXT | Hash of cluster features |
| `cluster` | TEXT | e.g. `refactor`, `debug`, `quick_edit` |
| `routerModel` | TEXT | |
| `pickedWorker` | TEXT | |
| `alternates` | TEXT JSON | Ranked list |
| `routerReason` | TEXT | |
| `routerConfidence` | TEXT | `high` \| `low` |
| `routerLatencyMs` | INTEGER | |
| `workerStatus` | INTEGER | HTTP status |
| `workerLatencyMs` | INTEGER | |
| `fallbackUsed` | INTEGER 0/1 | |
| `retries` | INTEGER | |
| `tokensIn` | INTEGER | |
| `tokensOut` | INTEGER | |
| `outcomeScore` | REAL | 0–100 |
| `objective` | TEXT | Snapshot at route time |
| `learningVersionId` | TEXT | FK |
| `meta` | TEXT JSON | exploration, tools, vision flags |

**Indexes:**

- `(comboName, timestamp DESC)`
- `(cluster, comboName)`
- `(pickedWorker)`

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

**Win rate heatmap:**

```sql
SELECT cluster, pickedWorker,
       COUNT(*) AS n,
       AVG(outcomeScore) AS avg_score
FROM routing_events
WHERE comboName = ? AND timestamp >= ?
GROUP BY cluster, pickedWorker;
```

**Recent decisions:**

```sql
SELECT timestamp, cluster, pickedWorker, outcomeScore, routerReason
FROM routing_events
WHERE comboName = ?
ORDER BY timestamp DESC
LIMIT 50;
```

## Retention

- Default: keep 90 days of `routing_events` (dashboard setting)
- Versions: keep all; user can delete old via UI (v1.1)
