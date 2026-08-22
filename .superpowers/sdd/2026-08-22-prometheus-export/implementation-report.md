# Prometheus Export Implementation Report

## Scope delivered

- Added bounded, read-only snapshots for lifetime usage by provider, retained routing outcomes, active requests by provider, and unexpired fetch-cache occupancy.
- Added a deterministic Prometheus 0.0.4 collector with the fixed family order, HELP text, types, label keys, fixed state/source enums, finite-sample enforcement, label escaping, and exactly one trailing newline.
- Added authenticated `GET /api/mgmt/v1/metrics`, disabled unless `PROMETHEUS_METRICS_ENABLED` is exactly `true`.
- Preserved authentication-first ordering, sanitized 404/503 management envelopes, atomic failure behavior, and success `Content-Type`, `Cache-Control`, and `X-Content-Type-Options` headers.
- Documented the environment toggle, authentication, scrape command, metric semantics, retention limits, and excluded sensitive/high-cardinality data.

## Behavioral TDD evidence

### Repository snapshots

Red:

```text
npx vitest run unit/prometheus-repositories.test.js
3 tests failed: getUsageMetricTotals, getRoutingMetricSnapshot, and getFetchCacheMetricSnapshot were not functions.
```

A later active-request snapshot test also failed red because `getActiveRequestMetricSnapshot` did not exist.

Green:

```text
npx vitest run unit/prometheus-repositories.test.js
1 file passed; 4 tests passed.
```

### Collector and formatter

Red:

```text
npx vitest run unit/prometheus-metrics.test.js
Suite failed because ../../src/lib/metrics/prometheus.js did not exist.
```

Green:

```text
npx vitest run unit/prometheus-metrics.test.js unit/prometheus-repositories.test.js
2 files passed; 10 tests passed.
```

### Management route

Red:

```text
npx vitest run unit/prometheus-metrics-route.test.js
Suite failed because src/app/api/mgmt/v1/metrics/route.js did not exist.
```

Green with existing management security coverage:

```text
npx vitest run unit/prometheus-metrics-route.test.js unit/mgmt-api-auth.test.js unit/mgmt-api-masking.test.js
3 files passed; 9 tests passed.
```

### Final focused verification

```text
npx vitest run unit/prometheus-repositories.test.js unit/prometheus-metrics.test.js unit/prometheus-metrics-route.test.js unit/mgmt-api-auth.test.js unit/mgmt-api-masking.test.js
5 files passed; 19 tests passed.
```

The full suite, build, lint, and formatter were intentionally not run per controller instructions.

## Real route smoke evidence

The development server binds to port 3000 in this worktree.

Enabled in a fresh process and temporary data directory:

- HTTP 200
- `content-type: text/plain; version=0.0.4; charset=utf-8`
- `cache-control: no-store`
- `x-content-type-options: nosniff`
- One ordered HELP/TYPE pair for every fixed family
- Finite zero-valued retained-routing, Auto-source, and cache samples
- Only the fixed `source` labels appeared in the empty-database scrape; no identity, key, model, prompt, response, endpoint, request/session, or error text appeared

Disabled in a second fresh process and temporary data directory:

```json
{"v":1,"error":{"message":"Prometheus metrics are disabled","code":"metrics_disabled"}}
```

The response was HTTP 404 with `Cache-Control: no-store`. Unauthorized HTTP 401 behavior is covered by the real management auth helper tests; sanitized atomic HTTP 503 behavior is covered at the route boundary.

## Commits

- `e55a3657` `feat: add bounded metrics snapshots`
- `1e09f08a` `feat: format low-cardinality metrics`
- `ca339b26` `feat(api): add opt-in metrics endpoint`
- `975e4713` `docs: describe prometheus export`

## Self-review and concerns

- Reviewed all 11 changed implementation, test, configuration, and operator-documentation files for authentication ordering, SQL injection, information disclosure, unbounded/high-cardinality dimensions, partial output, non-finite samples, and metric-type truthfulness. No unresolved correctness or security finding remains.
- The plan fixture's expected unattributed prompt/completion totals were arithmetically inconsistent with its seeded daily/provider totals. The test uses the truthful remainders: 10 prompt tokens and 4 completion tokens.
- The existing `getActiveRequests()` also initializes recent usage history and connection identity data. The collector instead uses the new process-local `getActiveRequestMetricSnapshot()` so a scrape does not enumerate usage history, model, account, connection name, or email data.
- Usage counters reset when the data directory is replaced or restored. Routing/error/fallback/Auto values remain gauges because retained routing rows can be purged or deleted.
- No dependency, public `/metrics` alias, key label, histogram, or cache hit/miss counter was added.

## Review fix round 1

Commit: `7a0727d7` `fix(metrics): bound scrape collection`

### Red evidence

- `prometheus-materialization.test.js` initially failed because migration 009 did not exist.
- The repository suite then failed four bounded-read/write/corruption cases: scrapes still read `usageDaily`, unconfigured providers remained separate, and corrupt compact usage/routing values did not reject.
- The collector suite failed the current-provider roster and concurrent single-flight cases.
- The cache corruption test resolved `{ entries: 1, bytes: 0 }` instead of rejecting.
- Existing migration-chain tests exposed version-9 fixture compatibility and schema-version expectations before the migration fix.

### Green evidence

```text
npx vitest run \
  unit/prometheus-materialization.test.js \
  unit/prometheus-repositories.test.js \
  unit/prometheus-metrics.test.js \
  unit/prometheus-metrics-route.test.js \
  unit/mgmt-api-auth.test.js \
  unit/mgmt-api-masking.test.js \
  unit/db-migration-chain.test.js \
  unit/client-key-migration.test.js \
  unit/routing-repo-atomic.test.js \
  unit/routing-stats.test.js \
  unit/routing-stats-route.test.js \
  unit/connections-secret-hardening.test.js \
  unit/connection-secret-redaction.test.js

13 files passed; 55 tests passed.
```

### Fixes and remaining operational semantics

- Migration 009 reversibly backfills compact lifetime usage totals and fixed routing totals. Scrapes read only the provider-bounded usage table, six routing-total rows, current connections/active requests, and the already capped fetch cache.
- Usage and routing write paths update their materializations transactionally. Retention and combo deletion decrement routing totals; provider deletion rolls its lifetime usage into `unknown`.
- Corrupt compact usage, routing, or live cache-occupancy values reject collection, so the route returns the existing sanitized atomic 503 envelope.
- Provider labels are limited to the current configured roster plus `unknown`; deleted, retired, and unconfigured provider history cannot create permanent series.
- Concurrent scrapes share an in-flight collection and reuse a completed process-local snapshot for at most one second. Failed collections are not cached.
- `prometheusRoutingRequests` retains one support row per retained request so deletion can update the fixed totals; it follows routing retention and is never read by a scrape.

## Review fix round 2

Commit: `30b49e1b` `fix(metrics): harden aggregate recovery`

### Red evidence

- A real version-8 database with malformed `usageDaily` JSON caused migration 009 to throw before the route could respond.
- Strict numeric tests initially failed because the shared validator did not exist; repository behavior accepted whitespace, hex-like text, fractional integer fields, negative values, and arbitrary SQLite text through `Number(...)`.
- Provider-roster tests collapsed fixed Anthropic and a current provider-node ID to `unknown`; deleting the last Anthropic connection incorrectly retired its built-in lifetime counter, while deleting a custom provider node failed to retire its counter.
- The fresh legacy JSON import regression returned an empty compact usage snapshot because migration 009 ran before the import.
- Focused client-key usage tests exposed compatibility with isolated version-8 fixtures that do not yet contain the metrics tables.

### Green evidence

```text
npx vitest run \
  unit/prometheus-numeric.test.js \
  unit/prometheus-corrupt-startup-route.test.js \
  unit/prometheus-materialization.test.js \
  unit/prometheus-repositories.test.js \
  unit/prometheus-metrics.test.js \
  unit/prometheus-metrics-route.test.js \
  unit/mgmt-api-auth.test.js \
  unit/mgmt-api-masking.test.js \
  unit/db-migration-chain.test.js \
  unit/client-key-migration.test.js \
  unit/routing-repo-atomic.test.js \
  unit/routing-stats.test.js \
  unit/routing-stats-route.test.js \
  unit/connections-secret-hardening.test.js \
  unit/connection-secret-redaction.test.js \
  unit/compatible-provider-connections.test.js \
  unit/usage-repo-hardening.test.js \
  unit/usage-request-id.test.js \
  unit/client-key-usage.test.js \
  unit/cached-token-usage.test.js

20 files passed; 93 tests passed.
```

### Fixes and remaining operational semantics

- Migration 009 now records `prometheusMetricState.available=0` and completes startup when historical materialization is corrupt. A real version-8 startup test proves the authenticated enabled route returns sanitized HTTP 503 without partial text or exception details.
- Numeric validation accepts only JavaScript finite non-negative numbers. Request/token/routing/cache integer fields must also be integers; strings, whitespace, hex-like text, fractions, infinities, NaN, and negatives are rejected.
- The bounded provider roster is the union of fixed registry IDs, current custom connection IDs, current provider-node IDs, and `unknown`. Built-ins survive connection deletion; deleted custom IDs roll into `unknown`.
- Successful fresh legacy JSON import rebuilds the compact aggregates in the same transaction, so the first scrape includes imported lifetime usage.
- Version-8 write paths remain compatible when the metrics tables do not exist. Version-9 startup creates them before enabling collection.
- Metrics remain unavailable after a corrupt backfill until the underlying historical data is repaired and the bounded materialization is rebuilt; core database and gateway operation remain available.
