# Learning System

## Philosophy

The router prompt **skeleton is fixed**. Only injected sections change:

- Pool catalog (live stats)
- Learned rules (derived)
- Few-shot examples (curated from history)
- Bandit priors (implicit in catalog win rates)

This prevents unbounded prompt drift while allowing measurable improvement.

## Scoring function

```javascript
function computeOutcomeScore(event) {
  let score = 0;
  if (event.workerStatus >= 200 && event.workerStatus < 300 && !event.fallbackUsed) score += 40;
  if (event.routerConfidence === "high" && score > 0) score += 20;
  if (event.workerLatencyMs < event.clusterP50Latency) score += 15;
  if (event.fallbackUsed) score -= 30;
  if (event.workerStatus >= 400) score -= 20;
  if (event.tokensOut > 0) score += 10;
  if (event.userRating === 1) score += 25;
  if (event.userRating === -1) score -= 25;
  return Math.max(0, Math.min(100, score));
}
```

## Bandit update

Per (cluster, worker) after each event:

```
wins   += (outcomeScore >= 60) ? 1 : 0
attempts += 1
avgScore = running mean of outcomeScore
```

## Rule generation

For each cluster with ≥10 samples per worker pair:

```
if best.avgScore - second.avgScore > 15%:
  emit "For {cluster}, prefer {best.worker} (win rate {pct}%)"
```

Cap at 10 rules; drop lowest-impact when exceeded.

## Few-shot selection

Per cluster:

1. Filter events with `outcomeScore >= 85`
2. Sort by score DESC, dedupe by fingerprint
3. Take top `maxFewShots` (default 5)
4. Store **summary** only (first 120 chars of user intent + outcome)

## Eval / promote gate

Before promoting version N+1:

1. Take last 200 `routing_events` (or all if fewer)
2. **Replay:** for each event, would bandit + rules pick same worker?
3. Compute counterfactual score: if new policy picks different worker, use historical score for that (cluster, worker) or penalize unknown
4. `newEval = mean(counterfactual scores)`
5. Promote if `newEval >= oldEval + 2.0`

If not promoted, store as draft version (optional) or discard.

## Exploration (epsilon-greedy)

```javascript
if (Math.random() < explorationRate) {
  pickedWorker = randomChoice(pool);
  meta.exploration = true;
}
```

Exploration events still update bandit — critical for discovering better workers.

## Objective weighting

Applied in router prompt text and tie-break in optimizer:

| Objective | Tie-break |
|-----------|-----------|
| quality | Highest avgScore |
| balanced | avgScore - 0.001 * costRank |
| economy | Prefer lower cost tier when avgScore within 10% |
| latency | Lowest p50LatencyMs |

## Freeze learning

When `freezeLearning: true`:

- Continue routing with `activeLearningVersionId` artifacts
- Still log events (for future unfreeze)
- Relearn button disabled; scheduler skipped

## Manual vs scheduled learn

| Source | `router_learning_versions.source` |
|--------|-------------------------------------|
| Relearn now button | `manual` |
| Interval timer | `scheduled` |
| A/B auto-promote (future) | `ab_promoted` |

## Failure handling

```javascript
try {
  await runOptimizer(comboName);
} catch (err) {
  log.error("[ROUTING_LEARN]", err);
  return { ok: false, message: err.message };
  // routing unaffected
}
```

## Metrics for “is it working?”

Dashboard shows 7d trend:

- Mean outcomeScore per day
- Router accuracy proxy: % where picked worker = highest historical score for cluster
- Exploration rate actual vs configured

## Future (v2)

- Thompson sampling instead of epsilon-greedy
- Per-user clusters
- LLM-suggested rules with human approve
- Export/import learning versions
