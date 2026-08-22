# SDD ledger — plan: /Users/vijay/IdeaProjects/switchboard/.worktrees/gateway-priorities/docs/superpowers/plans/2026-08-22-prometheus-export.md

Preflight:
- Branch starts from reviewed client-key work at `1228a363`.
- Ruling: retained routing values are gauges; usageDaily values are counters with reset-on-data-restore semantics. Cost if wrong: dashboards can calculate invalid rates across restores.
- Ruling: one collector failure returns 503; no partial scrape. Cost if wrong: one corrupt optional repository removes all metrics for that scrape.
- Never emit client-key, connection, account, model, combo, endpoint, request/session, prompt, or response labels.
