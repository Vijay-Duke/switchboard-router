# SDD ledger — plan: /Users/vijay/IdeaProjects/switchboard/.worktrees/gateway-priorities/docs/superpowers/plans/2026-08-22-prometheus-export.md

Preflight:
- Branch starts from reviewed client-key work at `1228a363`.
- Ruling: retained routing values are gauges; usageDaily values are counters with reset-on-data-restore semantics. Cost if wrong: dashboards can calculate invalid rates across restores.
- Ruling: one collector failure returns 503; no partial scrape. Cost if wrong: one corrupt optional repository removes all metrics for that scrape.
- Never emit client-key, connection, account, model, combo, endpoint, request/session, prompt, or response labels.

Implementation: commits `1228a363..ef1e11d0`; 5 focused files / 19 tests and enabled/disabled smoke reported green.
Review: Spec FAIL; Quality CHANGES_REQUIRED; Security BLOCKED.
- Important: scrape parses lifetime high-cardinality daily JSON, scans retained routing rows, silently drops malformed daily data, and emits retired provider IDs forever.
- Ruling: bounded collection outweighs the original no-migration preference; a narrow compact aggregate migration/materialization is allowed. Cost if wrong: added write-path/migration complexity for an opt-in exporter.
- Fix round 1/5 started with original implementer; list in `review-findings-round1.md`.
- Fix round 1 complete in `7a0727d7`: migration-backed bounded snapshots, corrupt-source rejection, current provider roster, and 1s single-flight cache. Focused verification: 13 files / 55 tests passed.
