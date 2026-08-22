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
- Scoped correctness and security re-reviews started over `ef1e11d0..73d476f1`.
- Fix round 1 re-review: steady-state compact reads/single-flight passed. Still blocked by startup crash on corrupt history, loose numeric coercion, incomplete fixed-provider roster, and missing post-legacy-import aggregate rebuild.
- Fix round 2/5 started with original implementer; list in `review-findings-round2.md`.
- Fix round 2 complete in `30b49e1b`: corrupt-history startup recovery, strict numeric validation, fixed/custom/node provider roster, and post-legacy-import rebuild. Focused verification: 20 files / 93 tests passed.
- Scoped correctness and security re-reviews started over `73d476f1..002e17f6`.
- Fix round 2 re-review: Security APPROVED; startup/strict reads/roster/import rebuild passed. Correctness remains blocked because write-path SQLite arithmetic can coerce malformed compact rows before a scrape detects them.
- Fix round 3/5 started with original implementer; list in `review-findings-round3.md`.
- Fix round 3 complete in `efe70319`: strict pre-mutation validation, nested rollback, durable unavailable state, and preserved core writes. Focused verification: 20 files / 97 tests passed.
- Final scoped correctness and security re-reviews started over `002e17f6..aeac107c`.
- Final re-review: blocker ADDRESSED; Spec PASS; Quality APPROVED; Security APPROVED; no new Critical/Important finding.
- Prometheus task complete (commits `1228a363..aeac107c`, correctness and security review clean).
