# Switchboard — Project Direction

**Switchboard** is an intelligent model-routing gateway: one OpenAI-compatible endpoint, multi-provider accounts, combo strategies, and a dashboard for operations and learning.

**Product design (Auto + Learn):** [docs/switchboard/README.md](docs/switchboard/README.md)

## Quick links

| Doc | Purpose |
|-----|---------|
| [SPEC.md](docs/switchboard/SPEC.md) | Product + engineering specification |
| [ARCHITECTURE.md](docs/switchboard/ARCHITECTURE.md) | Runtime flow and components |
| [DATABASE.md](docs/switchboard/DATABASE.md) | SQLite schema for routing events / learning |
| [DASHBOARD.md](docs/switchboard/DASHBOARD.md) | UI screens and API routes |
| [LEARNING.md](docs/switchboard/LEARNING.md) | Scoring, optimizer, self-improvement loop |
| [PHASES.md](docs/switchboard/PHASES.md) | Implementation phases and acceptance criteria |

## North star

- **Route** every request with a visible router → worker decision
- **Learn** from outcomes via dashboard-triggered and in-process jobs
- **Operate** from the web dashboard (no required shell workflows for learning)

v1 target: Auto strategy (Phase 1) + learning versions / insights (Phase 2).
