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

Review: Spec FAIL; Quality CHANGES_REQUIRED; Security BLOCKED.
- Important: non-chat consumers are uncounted; >60s live work is forgotten; stale affinity survives no/all-capped candidates; affinity/log state lacks client-key isolation/redaction; global FIFO allows cross-scope eviction; provider settings save can overwrite after failed GET.
- Fix round 1/5 started with original implementer; list in `review-findings-round1.md`.

Review fix round 1 complete:
- Added exact response-aware lifecycle counting for every non-chat/native-Gemini scheduler consumer and removed 60-second force clearing.
- Invalidated zero/all-capped affinity, scoped derivation/storage/eviction by canonical provider and client key, and made assistant affinity stateless.
- Redacted session carriers from request-log files and Codex debug output.
- Made both scheduler settings surfaces read-merge-PATCH transactionally and update visible state only after success.
- Focused proof: 24 files, 132 tests passed; React Doctor reported only the existing provider-component state-count warnings.
- Commits: `4c147f7a`, `394188f9`, `b43bb5d1`, `37276586`.
