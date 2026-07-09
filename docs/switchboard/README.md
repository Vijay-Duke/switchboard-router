# Switchboard

**Intelligent model routing** with self-improving combo strategies.

## What this is

A dashboard-driven **combo Auto strategy**: a router model picks the best worker from a user-defined pool on **every request**, logs outcomes, and **self-improves** over time via in-process learning (no external cron required).

Inspired by Cursor/Kiro-style “Auto”, but:

- You own the model pool
- Routing decisions are visible
- Learning adapts to **your** usage patterns
- Setup and operations live in the web dashboard

## Documents

| File | Contents |
|------|----------|
| [SPEC.md](./SPEC.md) | Full product + engineering specification |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Runtime flow, components, integration points |
| [DATABASE.md](./DATABASE.md) | SQLite schema for events and learning versions |
| [DASHBOARD.md](./DASHBOARD.md) | UI screens, controls, API routes |
| [LEARNING.md](./LEARNING.md) | Scoring, optimizer, self-improvement loop |
| [PHASES.md](./PHASES.md) | Implementation phases and acceptance criteria |

## Default router model

`claude-opus-4-8` (or equivalent strongest available router) — user-configurable in the dashboard.

## Status

**Phase 1 + Phase 2 foundation shipped in-tree:**

- Combo strategy `auto` → `handleAutoChat` (router → worker)
- SQLite `routing_events` + `router_learning_versions` (migration `002-routing-auto`)
- `POST /api/routing/learn`, `GET /api/routing/insights`, version promote/rollback
- Combos UI: Auto block (router, objective, Relearn) + Insights page
- Unit tests: `tests/unit/switchboard-auto.test.js`

Phase 3 (scheduler, freeze UX polish, retention job, response headers) still open — see [PHASES.md](./PHASES.md).
