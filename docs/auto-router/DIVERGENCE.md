# Divergence from 9Router

## Decision

We are **not** continuing to build the Auto Router feature inside 9Router.

Instead, this design is captured here as a **standalone product specification** to be implemented separately (new codebase or fork stripped of unrelated gateway scope).

## Why leave 9Router

| Factor | Issue |
|--------|-------|
| **Scope** | 9Router is a 40+ provider gateway, translator engine, MITM, CLI tools, cloud sync. Auto Router is one focused capability. |
| **Coupling** | Combo strategies, settings JSON, `open-sse/services/combo.js`, and dashboard combos page are deeply tied to 9Router’s architecture. |
| **Customization debt** | Local forks accumulated provider-specific patches (removed before this export). |
| **Product identity** | Auto Router is “intelligent routing + learning”, not “yet another 9Router combo mode”. |
| **Operability** | Target UX is dashboard-only learning with no `agents sync`, CLI profiles, or manual `config.toml` editing. |

## What we keep from 9Router (as ideas, not code)

- **Fusion two-phase pattern** — fan-out / orchestrate → execute (proven in `handleFusionChat`)
- **Capacity auto-switch** — `detectRequiredCapabilities` + `reorderByCapabilities`
- **Combo settings shape** — per-combo strategy in settings (`comboStrategies`)
- **In-process scheduler pattern** — like `quotaAutoPing` for learning jobs
- **Usage / event logging** — extend toward `routing_events`

## What we do not ship from 9Router

- Kraken / employer-specific providers, MCP configs, or internal URLs
- Personal tokens, API keys, or auth artifacts
- 9Router-specific Codex dashboard apply paths tied to `~/.codex/config.toml`
- Full translator / 40-provider registry (unless needed later as optional integration)

## Repository layout

```
docs/auto-router/     ← this specification (source of truth for v1)
```

Implementation should start fresh or from a minimal routing core, using this spec as the contract.
