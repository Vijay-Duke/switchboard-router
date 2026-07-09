# Switchboard — Full Specification

**Version:** 1.0  
**Status:** Draft  
**Constraint:** Dashboard-only operations — no CLI, no external cron, no manual config files.

---

## 1. Executive summary

Switchboard adds a combo strategy **Auto** that:

1. Runs a **router LLM** on every request to pick one **worker** from a user-defined pool
2. Executes the full agent/chat request on the chosen worker (tools, streaming)
3. Logs routing decisions and outcomes to SQLite
4. **Self-improves** by updating structured learning artifacts (bandit stats, few-shots, rules) via dashboard-triggered and in-server learning jobs

Default router model: **`claude-opus-4-8`** (or user’s strongest cheap-reliable model).

Unlike Cursor `cu/default` (opaque server-side pick), the user owns the pool and sees routing in the dashboard.

---

## 2. Goals and non-goals

### Goals

| ID | Goal | Success metric |
|----|------|----------------|
| G1 | Cursor-like routing | Right model for task type without manual pick |
| G2 | Always re-route | Fresh router call every turn (no sticky default) |
| G3 | Self-improving | Routing score trends up over 30 days |
| G4 | Dashboard-only | Zero CLI steps for setup, learn, rollback |
| G5 | Safe learning | Versioned context; one-click rollback |

### Non-goals (v1)

- CLI or shell scripts for learning
- External cron / offline batch outside the running server process
- Free-form LLM rewriting of entire router prompt without guardrails
- Nested combos as router targets
- Cross-user federated learning
- Replacing Fallback / Round Robin / Fusion strategies in systems that already have them

---

## 3. User stories

1. Create combo `auto` with pool `[nano, sonnet, opus, provider-auto]` and strategy **Auto**, router `claude-opus-4-8`.
2. Every client request to `auto` is routed without manual model selection.
3. Open **Combos → auto → Routing Insights** — win rates, recent decisions, model performance by task cluster.
4. Click **Relearn now** — in-process optimizer runs, promotes vN+1 or reports “no improvement”.
5. Set objective **Economy** — router prefers cheaper models when scores are close.
6. Roll back learning version if quality drops.
7. (v1.1) Thumbs up/down on routed responses to strengthen signals.

---

## 4. Strategy comparison

| Strategy | Intelligence | Calls/request | Best for |
|----------|--------------|---------------|----------|
| Fallback | None | 1 | Reliability |
| Round Robin | None | 1 | Load spread |
| Fusion | Panel + judge merge | N+1 | Max quality |
| **Auto** | Router picks 1 worker | **2** | Smart routing + learning |

**Capacity auto-switch** (heuristic pre-filter for vision/PDF) runs **before** the router when `capacityAutoSwitch !== false` **and** `autoTuning.heuristicFirst !== false` (both default true). Not a replacement for Auto.

---

## 5. Combo configuration schema

```typescript
type ComboAutoStrategy = {
  fallbackStrategy: "auto";

  routerModel: string;              // default: "claude-opus-4-8"
  // worker pool = combo.models \ { routerModel }

  objective: "quality" | "balanced" | "economy" | "latency";
  routeEveryTurn: true;             // v1: always true, non-configurable

  learningEnabled: boolean;         // default: true
  learningWindowDays: number;       // default: 14
  explorationRate: number;          // 0–0.2, default: 0.05
  autoLearnIntervalHours: number;     // 0 = manual only; default: 24
  freezeLearning: boolean;          // default: false

  autoTuning?: {
    routerTimeoutMs: number;        // default: 15000
    maxFewShots: number;            // default: 5
    minEventsBeforeLearn: number;   // default: 50
    heuristicFirst: boolean;        // default: true
  };

  activeLearningVersionId?: string;
};
```

---

## 6. Runtime flow (`handleAutoChat`)

```
1. pool ← combo.models minus routerModel
2. if |pool| == 0 → 400
3. if |pool| == 1 → execute worker directly

4. required ← detectRequiredCapabilities(body)
5. if heuristicFirst && capability filter leaves 1 model → skip router

6. learning ← load promoted router_learning_versions for combo
7. routerBody ← buildRouterPrompt({ pool, body, learning, objective, health })
8. routerRes ← execute(routerBody, routerModel)  // non-stream, no tools
9. parse JSON: { model, cluster, confidence, reason, alternates? }
10. validate model ∈ pool else pool[0]

11. if exploration (epsilon) → random pool pick, log meta.exploration

12. workerRes ← execute(full body, pickedWorker)  // stream + tools
13. score ← computeOutcomeScore(...)
14. insert routing_events (async, fail-open)
15. return workerRes
```

### Router prompt skeleton (fixed; dynamic sections injected)

```text
You are the ROUTER for combo "{{comboName}}".
Pick exactly ONE worker from POOL.
Objective: {{objective}}.

POOL (id — capabilities — 7d win rate — p50 latency — health):
{{pool_catalog}}

LEARNED RULES:
{{learned_rules}}

SIMILAR SUCCESSFUL ROUTES:
{{few_shots}}

REQUEST SIGNALS:
- modalities: {{modalities}}
- tools: {{has_tools}}
- token band: {{token_band}}
- user intent (compressed): {{user_summary}}

JSON only:
{"model":"<id>","cluster":"<slug>","confidence":"high|low",
 "reason":"<line>","alternates":["..."]}
```

### Failure modes

| Failure | Behavior |
|---------|----------|
| Router timeout / bad JSON | Use pool[0], log failure |
| Worker fails | Try all `alternates[]` then full pool fallback chain (skip already-attempted) |
| Learning &lt; min events | UI: “Need N more requests” |
| Eval regression on relearn | Do not promote |
| freezeLearning | Route with frozen version; still log events |

All learning failures **fail-open** — routing never blocks.

---

## 7. Request fingerprint and clusters

**Fingerprint** (hashed):

- `has_vision`, `has_pdf`, `has_tools`, `tool_count_band`
- `user_token_band`: 0–500 | 500–2k | 2k–8k | 8k+
- `keyword_hints`: refactor, debug, test, explain (regex, no extra LLM)

**Cluster** — from router JSON output; optimizer aggregates statistics per cluster.

---

## 8. Outcome scoring

```
score = 0
+ 40  worker 2xx, no fallback
+ 20  high confidence + success
+ 15  latency below cluster p50
- 30  fallback/retry used
- 20  worker 4xx/5xx
+ 10  non-empty completion
± 25  user feedback (v1.1)
```

Normalized 0–100 → `routing_events.outcomeScore`.

---

## 9. Self-improvement model

### What improves (safe)

| Artifact | Updates via |
|----------|-------------|
| Bandit table (cluster × model win rates) | Nightly / manual relearn |
| Learned rules | Derived from bandit deltas |
| Few-shot examples | Top-scoring historical routes |
| Prompt skeleton | **Fixed in v1** |

### What does NOT auto-change in v1

- Full free-form prompt rewrite without eval + approval

### Learning triggers (dashboard + in-server)

| Trigger | UI |
|---------|-----|
| Relearn now | Button → `POST /api/routing/learn` |
| Auto-relearn | Toggle + interval (6h–72h) via in-process scheduler |
| Promote / Rollback | Version history panel |

Pattern: same as in-server schedulers (e.g. quota warm-up jobs) — **not** external cron.

### Optimizer steps

1. Aggregate `routing_events` in `learningWindowDays`
2. Build bandit table per (cluster, worker)
3. Emit learned rules when sample ≥ 10 and delta > 15%
4. Select top few-shots per cluster by outcomeScore
5. Eval: replay last N events — would new policy beat old?
6. Promote if evalScore improves by ≥ 2% margin

### Exploration

`explorationRate` (default 5%): epsilon-greedy random worker to discover improvements.

---

## 10. Suggested starter pool

```
fast-model          # cheap / quick edits
balanced-model      # daily driver
reasoning-model     # hard refactors / architecture
provider-auto       # optional: delegate to upstream "auto" model
```

Router: `claude-opus-4-8` — **excluded** from worker pool.

---

## 11. Observability

Log lines:

```
[AUTO] combo="auto" cluster=refactor router=opus → worker=sonnet score=82 340ms+2100ms
[ROUTING_LEARN] combo="auto" v3→v4 eval 71.2→74.8 promoted
```

Response headers (opt-out — emitted by default; set `emitAutoRouterHeaders: false` on the combo strategy to disable):

- `X-Auto-Router-Worker`
- `X-Auto-Router-Cluster`
- `X-Auto-Router-Confidence`
- `X-Auto-Router-Score` (when available)
- `X-Auto-Router-Exploration` (when ε-greedy)

---

## 12. Security and privacy

- All learning data in local SQLite
- Few-shots store **summaries**, not full user prompts (v1)
- No cloud telemetry unless explicitly added later
- **Local single-user gateway posture (no login dashboard):**  
  - All `/api/*` except public LLM prefixes (`/v1`, `/api/v1`, …) require **loopback** or the CLI machine token — including insights, settings, keys, providers (LAN bind is not an open admin API).  
  - Mutating learn/promote/rollback are also loopback/CLI-only.  
  - There is no session/password gate on the dashboard UI; data APIs are still local-only.

---

## 13. Acceptance criteria

1. User configures Auto entirely in dashboard
2. Every chat request performs router + worker calls
3. Events visible in Insights within 5s
4. After ≥50 events, Relearn produces v2 or “no improvement”
5. Rollback restores prior version immediately
6. No CLI required for any step
7. `freezeLearning` stops updates but routing continues

---

## 14. Open decisions

1. Chat-only v1 — defer TTS/image/search?
2. ~~Worker failure — one router alternate vs full fallback chain?~~ **Resolved:** both — try all declared `alternates` in order, then the remaining pool as a full fallback chain (`handleAutoChat`). Open decision closed.
3. Few-shot privacy — summaries only vs truncated prompts?
4. Ship example `auto` combo on first run?

---

## 15. Relation to Cursor/Kiro Auto

| | Cursor/Kiro Auto | Switchboard |
|--|------------------|-------------|
| Pool | Opaque catalog | User-defined |
| Router | Their servers | User-chosen router model |
| Learning | Opaque | Visible bandit + versions |
| Config | IDE / provider | Dashboard only |
| Cost | 1 call (hidden router) | 2 calls (explicit) |

---

See also: [ARCHITECTURE.md](./ARCHITECTURE.md), [DATABASE.md](./DATABASE.md), [DASHBOARD.md](./DASHBOARD.md), [LEARNING.md](./LEARNING.md), [PHASES.md](./PHASES.md).
