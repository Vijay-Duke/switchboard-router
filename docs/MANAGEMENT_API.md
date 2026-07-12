# Management API v1

## Overview

`/api/mgmt/v1` is Switchboard's stable, machine-facing management contract. It is intended for local tray applications, quota widgets, and operational panels, and is modeled on the CLIProxyAPI Management API. It is not the OpenAI-compatible inference API (`/v1`).

All responses are JSON and send `Cache-Control: no-store`.

### Authentication and network boundary

The Management API is **local-only by default**. A request that satisfies Switchboard's trusted-loopback checks may access it without an extra token. `Host`, `Origin`, and (when applicable) socket peer checks are used to prevent a remote caller from claiming to be local.

To permit remote/LAN management access, configure a non-empty `MANAGEMENT_TOKEN` and send:

```http
Authorization: Bearer <MANAGEMENT_TOKEN>
```

If the request is not trusted local and `MANAGEMENT_TOKEN` is absent, empty, malformed, or does not match, access fails closed with `401`. The token is compared in constant time. This token extends access **only** to `/api/mgmt/*`; it never weakens the local-only policy for other sensitive routes.

### Envelopes and errors

Every successful response has this envelope:

```json
{"v":1,"data":{}}
```

Every error response has this envelope:

```json
{"v":1,"error":{"message":"Combo not found","code":"not_found"}}
```

`code` is optional. Known codes include `unauthorized` and `not_found`. Validation failures use `400`; missing resources use `404`; unexpected failures use `500`.

All examples below show the value under `data` wrapped in the success envelope.

## Shared types

### Combo views and records

Read endpoints return this combo view:

```json
{
  "id": "0c8ce21c-d8c9-46d4-b00a-4c2baf758d87",
  "name": "coding",
  "kind": "llm",
  "models": ["anthropic/claude-sonnet-4", "openai/gpt-5.4"],
  "strategy": {"fallbackStrategy":"auto","routerModel":"anthropic/claude-haiku-4.5"},
  "routerModel": "anthropic/claude-haiku-4.5",
  "fallbackStrategy": "auto"
}
```

`id`, `name`, `kind`, and `models` are persisted combo fields. `kind` may be `null`; management list results include only `llm` (or legacy unset-kind) combos. `strategy` is the per-combo strategy object, or `null` if none is saved. `routerModel` and `fallbackStrategy` are convenience projections from `strategy` and are `null` when absent.

Create and update return the persisted combo record instead: `{ id, name, kind, models, createdAt, updatedAt }`; they do not add strategy projections.

A combo name is required on create and, when supplied on update, must contain only letters, numbers, `.`, `_`, and `-`; it must be unique. `models` is an array of model identifiers.

### Strategy

A strategy is an object keyed by combo name in Switchboard settings. The stable commonly used fields are:

| Field | Type | Meaning |
| --- | --- | --- |
| `fallbackStrategy` | string | `fallback`, `round-robin`, `fusion`, or `auto` |
| `routerModel` | string | Required non-empty router model when `fallbackStrategy` is `auto` |
| `judgeModel` | string | Judge model for fusion routing |
| `objective` | string | Auto-routing objective, such as `balanced` |
| `capacityAutoSwitch` | boolean | Whether capacity-driven switching is enabled |
| `learningEnabled` | boolean | Enables Auto learning |
| `freezeLearning` | boolean | Stops Auto learning updates |
| `explorationRate` | number | Auto-routing exploration rate |

Additional strategy fields may be returned as Switchboard adds capabilities. To set a strategy, send the complete strategy object you want stored. The body must be a JSON object; an `auto` strategy without a non-empty `routerModel` is rejected with `400`.

Strategy writes are allowlisted to the known schema: `fallbackStrategy`, `routerModel`, `objective`, `judgeModel`, `explorationRate`, `explorationRateCap`, `learningEnabled`, `learningWindowDays`, `freezeLearning`, `activeLearningVersionId`, `autoLearnIntervalHours`, `capacityAutoSwitch`, `emitAutoRouterHeaders`, `autoTuning` (`heuristicFirst`, `maxFewShots`, `minEventsBeforeLearn`), and `fusionTuning` (`cachedRoutes`, `policyFastPath`, `routerTimeoutMs`). Unknown keys are silently dropped and never persisted; the response `strategy` reflects exactly what was stored. Combo writes (`POST`/`PUT` on combos) are likewise limited to `name`, `models`, and `kind`.

## Endpoints

### `GET /api/mgmt/v1/providers`

Returns configured provider accounts and provider nodes. Credentials and tokens are never returned.

**Parameters:** none.

**Response data shape:**

- `providers`: `Array<{ provider: string, accounts: ProviderAccount[] }>`
- `nodes`: `ProviderNode[]`
- `counts`: `{ providers: number, accounts: number, nodes: number }`
- `ProviderAccount`: `id`, `provider`, `authType`, `name`, `email`, `priority`, `isActive`, `createdAt`, `updatedAt`, `displayName`, `defaultModel`, `globalPriority`, `testStatus`, `lastTested`, `lastError`, `lastErrorAt`, `rateLimitedUntil`, `errorCode`, `hasApiKey`, `hasOAuth`, `hasIdToken`
- `ProviderNode`: `id`, `name`, `type`, `prefix`, `apiType`, `baseUrl`, `createdAt`, `updatedAt`

```json
{
  "v": 1,
  "data": {
    "providers": [{
      "provider": "anthropic",
      "accounts": [{
        "id": "acct_01", "provider": "anthropic", "authType": "oauth",
        "name": "Work", "email": "dev@example.com", "priority": 0,
        "isActive": true, "createdAt": "2026-07-12T09:00:00.000Z",
        "updatedAt": "2026-07-12T09:00:00.000Z", "displayName": "Work",
        "defaultModel": null, "globalPriority": 0, "testStatus": "ok",
        "lastTested": "2026-07-12T09:10:00.000Z", "lastError": null,
        "lastErrorAt": null, "rateLimitedUntil": null, "errorCode": null,
        "hasApiKey": false, "hasOAuth": true, "hasIdToken": false
      }]
    }],
    "nodes": [{"id":"node_01","name":"Anthropic","type":"provider","prefix":"anthropic","apiType":"anthropic","baseUrl":null,"createdAt":"2026-07-12T09:00:00.000Z","updatedAt":"2026-07-12T09:00:00.000Z"}],
    "counts": {"providers":1,"accounts":1,"nodes":1}
  }
}
```

### `GET /api/mgmt/v1/combos`

Lists manageable LLM combos.

**Parameters:** none.

**Response data shape:** `{ combos: Combo[] }`.

```json
{"v":1,"data":{"combos":[{"id":"0c8ce21c-d8c9-46d4-b00a-4c2baf758d87","name":"coding","kind":"llm","models":["anthropic/claude-sonnet-4","openai/gpt-5.4"],"strategy":{"fallbackStrategy":"auto","routerModel":"anthropic/claude-haiku-4.5"},"routerModel":"anthropic/claude-haiku-4.5","fallbackStrategy":"auto"}]}}
```

### `POST /api/mgmt/v1/combos`

Creates a combo.

**Body:** `{ name: string, models?: string[], kind?: string|null }`. `models` defaults to `[]`; `kind` defaults to `null`.

**Response data shape:** `{ id, name, kind, models, createdAt, updatedAt }`; status `201`.

```json
{"v":1,"data":{"id":"0c8ce21c-d8c9-46d4-b00a-4c2baf758d87","name":"coding","kind":"llm","models":["anthropic/claude-sonnet-4"],"createdAt":"2026-07-12T10:00:00.000Z","updatedAt":"2026-07-12T10:00:00.000Z"}}
```

### `GET /api/mgmt/v1/combos/[id]`

Gets one combo by its opaque `id`.

**Path parameters:** `id` — combo ID.

**Response data shape:** `Combo`.

```json
{"v":1,"data":{"id":"0c8ce21c-d8c9-46d4-b00a-4c2baf758d87","name":"coding","kind":"llm","models":["anthropic/claude-sonnet-4"],"strategy":{"fallbackStrategy":"fallback"},"routerModel":null,"fallbackStrategy":"fallback"}}
```

### `PUT /api/mgmt/v1/combos/[id]`

Replaces the supplied persisted combo fields while retaining omitted fields. Renaming a combo also moves its associated strategy and routing history.

**Path parameters:** `id` — combo ID.

**Body:** any subset of `{ name: string, models: string[], kind: string|null }`.

**Response data shape:** `{ id, name, kind, models, createdAt, updatedAt }`.

```json
{"v":1,"data":{"id":"0c8ce21c-d8c9-46d4-b00a-4c2baf758d87","name":"coding-fast","kind":"llm","models":["openai/gpt-5.4"],"createdAt":"2026-07-12T10:00:00.000Z","updatedAt":"2026-07-12T10:05:00.000Z"}}
```

### `DELETE /api/mgmt/v1/combos/[id]`

Deletes a combo, its per-combo strategy, and routing data keyed to its name.

**Path parameters:** `id` — combo ID.

**Response data shape:** `{ success: true }`.

```json
{"v":1,"data":{"success":true}}
```

### `PUT /api/mgmt/v1/combos/[id]/strategy`

Sets a combo's per-combo routing strategy and resets its rotation state.

**Path parameters:** `id` — combo ID.

**Body:** a `Strategy` object. For example:

```json
{"fallbackStrategy":"auto","routerModel":"anthropic/claude-haiku-4.5","objective":"balanced","capacityAutoSwitch":true}
```

**Response data shape:** `{ combo: string, strategy: Strategy }`.

```json
{"v":1,"data":{"combo":"coding","strategy":{"fallbackStrategy":"auto","routerModel":"anthropic/claude-haiku-4.5","objective":"balanced","capacityAutoSwitch":true}}}
```

### `GET /api/mgmt/v1/usage`

Returns aggregate usage and safe quota/account status.

**Query parameters:** `period` — optional; one of `today`, `24h`, `7d` (default), `30d`, `60d`, or `all`.

**Response data shape:**

- `period`: selected period
- `usage`: aggregate usage object with `totalRequests`, `totalPromptTokens`, `totalCompletionTokens`, `totalCachedTokens`, `totalCost`, `byProvider`, `byModel`, `byAccount`, `byApiKey`, `byEndpoint`, `last10Minutes`, `pending`, `activeRequests`, `recentRequests`, and `errorProvider`
- `quota.connections`: `Array<{ id, provider, name, rateLimitedUntil, testStatus }>`

```json
{"v":1,"data":{"period":"7d","usage":{"totalRequests":42,"totalPromptTokens":12000,"totalCompletionTokens":3100,"totalCachedTokens":500,"totalCost":0.18,"byProvider":{"anthropic":{"requests":42,"promptTokens":12000,"completionTokens":3100,"cachedTokens":500,"cost":0.18}},"byModel":{},"byAccount":{},"byApiKey":{},"byEndpoint":{},"last10Minutes":[],"pending":{"byModel":{},"byAccount":{}},"activeRequests":[],"recentRequests":[],"errorProvider":""},"quota":{"connections":[{"id":"acct_01","provider":"anthropic","name":"Work","rateLimitedUntil":null,"testStatus":"ok"}]}}}
```

### `GET /api/mgmt/v1/routing`

Returns the list of combos with routing events, or routing performance for one combo.

**Query parameters:**

- `combo` — optional combo name. Omit it to list available combo names.
- `days` — only with `combo`; optional number clamped to `1..90`, default `14`.

**Response data shape without `combo`:** `{ combos: string[] }`.

```json
{"v":1,"data":{"combos":["coding","review"]}}
```

**Response data shape with `combo`:** `{ combo, days, modelPerf, eventCount, attemptCount, scoreTrend }`, where `modelPerf` rows contain `worker`, `n`, `avgScore`, `avgLatencyMs`, and `errors`; `scoreTrend` rows contain `day`, `avgScore`, and `n`.

```json
{"v":1,"data":{"combo":"coding","days":14,"modelPerf":[{"worker":"openai/gpt-5.4","n":12,"avgScore":82.5,"avgLatencyMs":940,"errors":0}],"eventCount":12,"attemptCount":13,"scoreTrend":[{"day":"2026-07-12","avgScore":82.5,"n":12}]}}
```

### `GET /api/mgmt/v1/health`

Returns gateway, database, and provider-account health.

**Parameters:** none.

**Response data shape:** `{ status, uptimeSeconds, db: { ok }, providers: { total, ok, error, rateLimited }, timestamp }`.

```json
{"v":1,"data":{"status":"ok","uptimeSeconds":864,"db":{"ok":true},"providers":{"total":2,"ok":2,"error":0,"rateLimited":0},"timestamp":"2026-07-12T10:00:00.000Z"}}
```

### `GET /api/mgmt/v1/version`

Returns Switchboard and runtime version metadata.

**Parameters:** none.

**Response data shape:** `{ name, version, apiVersion, node, platform, startedAt }`.

```json
{"v":1,"data":{"name":"switchboard-app","version":"1.0.0","apiVersion":1,"node":"v22.0.0","platform":"darwin","startedAt":"2026-07-12T09:45:36.000Z"}}
```

## Version policy

v1 is additive-only: field names and types are stable, and new optional fields may be added. Breaking changes require a new versioned base path, for example `/api/mgmt/v2`.
