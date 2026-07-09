# Architecture

## System context

```
┌─────────────────────────────────────────────────────────────┐
│                     Dashboard (Web UI)                     │
│  Combos │ Auto strategy │ Router │ Objective │ Learn        │
└───────────────────────────┬─────────────────────────────────┘
                            │ REST API
┌───────────────────────────▼─────────────────────────────────┐
│                      API Layer                               │
│  /api/settings  /api/routing/learn  /api/routing/insights   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                   Routing Engine                             │
│  handleAutoChat()                                            │
│    ├─ heuristicPreFilter()                                   │
│    ├─ buildRouterPrompt() + router LLM call                  │
│    ├─ validatePick() + exploration                           │
│    ├─ worker LLM call                                        │
│    └─ recordRoutingEvent() [async]                           │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     SQLite                                   │
│  routing_events │ router_learning_versions                   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│              Learning Scheduler (in-process)                 │
│  manual POST /learn  +  optional interval timer              │
│  → optimizer → new version → promote or skip                   │
└─────────────────────────────────────────────────────────────┘
```

## Component map (greenfield)

| Component | Responsibility |
|-----------|----------------|
| `handleAutoChat` | Orchestrate route → execute → score → log |
| `buildRouterPrompt` | Merge skeleton + bandit + rules + few-shots |
| `detectRequiredCapabilities` | Vision/PDF/tools signals |
| `reorderByCapabilities` | Heuristic pre-filter |
| `routingRepo` | CRUD for events and versions |
| `optimizer` | Bandit, rules, few-shots, eval |
| `learningScheduler` | In-process timer (configurable from dashboard) |
| `RoutingInsightsPage` | Dashboard visualization |

## Two-phase execution (vs Fusion)

| Phase | Fusion | Auto |
|-------|--------|------|
| Phase 1 | N panel models (parallel) | 1 router model (serial) |
| Phase 2 | 1 judge synthesizes | 1 worker executes full request |
| Tools in phase 1 | Stripped | Stripped (router only) |
| Streaming | Judge streams | Worker streams |

## Integration with existing gateway (if forked)

If implemented inside a gateway similar to 9Router:

- Hook in chat handler when `comboStrategy === "auto"`
- Reuse `handleSingleModel` / executor dispatch
- Reuse `getCapabilitiesForModel` for pool catalog
- Reuse settings `comboStrategies[comboName]`

**Recommended for greenfield:** thin gateway + routing service, not full 40-provider translator.

## Scheduler lifecycle

```javascript
// On server boot (same pattern as quota auto-ping)
global.__autoRouterLearn = { interval: null };

function startLearningScheduler() {
  const settings = await getGlobalOrPerComboSettings();
  if (intervalHours > 0) {
    setInterval(() => runOptimizerForEnabledCombos(), intervalHours * 3600000);
  }
}
```

Manual **Relearn** calls the same `runOptimizer(comboName)` synchronously (with UI spinner).

## Data flow per request

```
Client POST /v1/chat/completions  model=auto
  → resolve combo "auto"
  → load comboStrategies.auto
  → handleAutoChat
  → Response (streamed from worker)
  → background: INSERT routing_events
```

## Health signals for pool catalog

Router prompt includes live health per model:

- Recent 429 rate (from events)
- p50 latency (7d)
- Last failure timestamp

Computed at request time from `routing_events` aggregates — no external monitoring.
