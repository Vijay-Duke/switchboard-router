# SDD ledger — plan: /Users/vijay/IdeaProjects/switchboard/.worktrees/gateway-priorities/docs/superpowers/plans/2026-08-22-account-scheduler-v2.md

Preflight:
- Branch starts from reviewed client-key work at `1228a363`.
- Ruling: `maxConcurrentRequests` is a process-local best-effort selection cap based on observed pending counts, not a reservation/hard semaphore. UI/docs must say so. Cost if wrong: brief concurrent selections can overshoot; strict caps require cross-handler lease plumbing outside this scope.
- Preserve disabled legacy selection exactly and keep scheduler ownership isolated from telemetry.

Completed:
- Tasks 1–6 landed at the named plan boundaries; final numeric-signal/UI-honesty correction landed separately.
- Focused final proof: 12 files, 88 tests passed.
- Real UI QA covered both provider surfaces, nested-setting preservation, 1/1440-minute affinity, Round Robin disable/restore semantics, cap 1/null persistence, direct invalid-cap rejection, and 375px overflow.
- Full suite/build/lint/format were skipped by assignment.
- See `implementation-report.md` for evidence, commits, scope audit, and operational concerns.
