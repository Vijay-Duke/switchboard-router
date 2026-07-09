# Product focus

## Decision

Switchboard’s product focus is **intelligent routing + learning**, not unbounded gateway surface area.

New work should prefer:

1. **Auto strategy** — router model picks a worker every turn
2. **Learning loop** — versioned rules / bandits / few-shots with dashboard promote & rollback
3. **Dashboard-first ops** — relearn, freeze, objective, insights without shell scripts

## Priorities

| Priority | Area |
|----------|------|
| P0 | Reliable OpenAI-compatible `/v1` proxy + combos |
| P1 | Auto route → execute + `routing_events` |
| P2 | Learning versions, insights, relearn / rollback |
| Later | Optional provider/MITM/CLI depth only when it serves routing quality |

## Ideas we reuse (patterns)

- Two-phase orchestration (plan/route → execute) — proven in Fusion-style flows
- Capacity pre-filters (`detectRequiredCapabilities` + reorder)
- Per-combo strategy settings (`comboStrategies`)
- In-process schedulers (same pattern as quota auto-ping)
- Usage / event logging extended toward `routing_events`

## Explicit non-goals for Auto v1

- Nested combos as router targets
- Free-form LLM rewrites of the entire router prompt without guardrails
- Cross-user federated learning
- External cron as the only way to run learning
