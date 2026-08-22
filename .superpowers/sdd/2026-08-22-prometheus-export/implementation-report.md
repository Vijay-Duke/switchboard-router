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
- No database schema, migration, dependency, request hot-path instrumentation, public `/metrics` alias, key label, histogram, or cache hit/miss counter was added.
