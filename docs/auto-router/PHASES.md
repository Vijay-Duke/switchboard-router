# Implementation Phases

## Phase 1 — Route (MVP)

**Goal:** Two-phase route → execute works; events logged.

| Task | Deliverable |
|------|-------------|
| Add `auto` to strategy enum | Settings schema |
| `handleAutoChat` | Core orchestration |
| `buildRouterPrompt` | Fixed skeleton + pool catalog |
| Router JSON parse + validation | Fail to pool[0] |
| `routing_events` migration + insert | Async fail-open |
| Combos UI: router picker, objective | Basic Auto block |
| Unit tests: parse, validate, score | `tests/unit/auto-router.test.js` |

**Acceptance:** Combo `auto` routes every request; events in DB; no learning yet.

**Estimate:** 3–5 days

---

## Phase 2 — Learn

**Goal:** Relearn produces versions; insights visible.

| Task | Deliverable |
|------|-------------|
| `router_learning_versions` migration | |
| Optimizer: bandit, rules, few-shots | |
| Eval gate before promote | |
| `POST /api/routing/learn` | |
| Inject learning into router prompt | |
| Routing Insights page (heatmap, recent) | |
| Relearn now button | |
| Version promote / rollback API | |

**Acceptance:** After 50+ events, Relearn promotes or reports no gain; rollback works.

**Estimate:** 5–7 days

---

## Phase 3 — Polish

**Goal:** Production-ready dashboard-only ops.

| Task | Deliverable |
|------|-------------|
| In-process learning scheduler | Interval from settings |
| Exploration rate | Epsilon-greedy |
| freezeLearning toggle | |
| Health in pool catalog | 429 / latency |
| Retention job for old events | 90d default |
| Response headers (opt-in) | X-Auto-Router-* |
| Docs + onboarding combo template | |

**Acceptance:** Full spec acceptance criteria (see SPEC.md §13).

**Estimate:** 3–4 days

---

## Phase 4 — Feedback (v1.1)

| Task | Deliverable |
|------|-------------|
| `routing_feedback` table | |
| Thumbs in client or dashboard | |
| Score adjustment | ±25 points |
| Feedback in optimizer | |

---

## Test plan

### Unit

- `buildRouterPrompt` with empty vs full learning
- JSON parse edge cases (markdown fences, trailing text)
- `computeOutcomeScore` boundaries
- Optimizer eval gate (promote / reject fixtures)

### Integration

- Mock router returns worker A → worker A executed
- Router timeout → pool[0]
- Learn with 49 events → rejected
- Learn with 100 events → version created

### Manual

1. Create combo with 3 workers
2. Send 20 varied prompts (code, vision, quick question)
3. Open Insights — verify clusters differ
4. Relearn — verify version bump or message
5. Rollback — verify prior rules in next route

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Router adds latency | Non-stream, short max_tokens, timeout fallback |
| Bad router picks | Exploration + learning + heuristic pre-filter |
| Prompt injection in user text | Router sees summary only; JSON schema strict |
| SQLite growth | Retention + indexes |
| Overfitting few-shots | Cap count; eval gate |

---

## Greenfield vs fork

| Approach | Pros | Cons |
|----------|------|------|
| **Greenfield** | Clean product, no 9Router baggage | Rebuild gateway |
| **Fork 9Router** | Reuse combo.js, executors | Large codebase, coupling |

**Recommendation:** Greenfield routing service; optional OpenAI-compatible proxy in front.

---

## File checklist (greenfield)

```
src/
  routing/
    handleAutoChat.js
    buildRouterPrompt.js
    optimizer.js
    scoring.js
    scheduler.js
  db/repos/routingRepo.js
  app/api/routing/
    learn/route.js
    insights/route.js
    versions/promote/route.js
    versions/rollback/route.js
  app/(dashboard)/dashboard/combos/[name]/routing/page.js
docs/auto-router/   ← this spec
tests/unit/auto-router*.test.js
```
