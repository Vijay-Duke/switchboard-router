# Auto Router

**Standalone intelligent model routing** — diverged from [9Router](https://github.com/decolua/9router).

## What this is

A dashboard-driven **combo Auto strategy**: a router model picks the best worker from a user-defined pool on **every request**, logs outcomes, and **self-improves** over time via in-process learning (no CLI, no external cron).

Inspired by Cursor/Kiro “Auto”, but:

- You own the model pool
- Routing decisions are visible
- Learning adapts to **your** usage patterns
- Everything is configured and operated from a web dashboard

## Documents

| File | Contents |
|------|----------|
| [DIVERGENCE.md](./DIVERGENCE.md) | Why we left 9Router |
| [SPEC.md](./SPEC.md) | Full product + engineering specification |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Runtime flow, components, integration points |
| [DATABASE.md](./DATABASE.md) | SQLite schema for events and learning versions |
| [DASHBOARD.md](./DASHBOARD.md) | UI screens, controls, API routes |
| [LEARNING.md](./LEARNING.md) | Scoring, optimizer, self-improvement loop |
| [PHASES.md](./PHASES.md) | Implementation phases and acceptance criteria |

## Default router model

`claude-opus-4-8` (or equivalent strongest available router) — user-configurable in dashboard.

## Status

**Planning / spec only** — not implemented in this repository. This folder captures the design to build as a standalone product or greenfield service.

## License note

The parent repository may contain 9Router upstream code (separate license). The **Auto Router design documents** in this folder are planning artifacts for a new product direction.
