# Switchboard competitor gap analysis

**Audit date:** 2026-08-22  
**Local version:** 0.6.31 (`package.json`)  
**Method:** Static source and first-party documentation audit. No builds, tests, linters, formatters, or runtime validation commands were run. No application source was modified.

## Decision summary

Earlier gap claims overstated what Switchboard lacks. The source implements real multi-account pooling, preferred-account pinning, fill-first and sticky round-robin, per-model/account cooldown with failover, and legacy per-connection proxies. The material findings are narrower:

1. **P0 security/data-model defect:** registered client keys are hashed, but chat usage writes the reusable inbound key verbatim into SQLite history and daily aggregates.
2. **Best-fit competitive gap:** account selection is not conversation-affine, least-inflight, concurrency-capped, or per-account quota-aware. CLIProxyAPI has the stronger account-scheduler contract.
3. **Real operational gap:** no Prometheus or OpenTelemetry export.
4. **Keys authenticate but do not govern:** no model scopes, RPM/TPM, expiry, budgets, users, teams, or RBAC.
5. **MCP is partial:** config catalog/projection plus fixed preset stdio-to-SSE bridges, not one aggregated and policy-controlled MCP namespace.
6. **Realtime, rerank, batches, multi-user administration, and distributed state are absent.** Most are intentional or low-fit for a local coding gateway.
7. **Gateway response caching is limited to web fetch and search.** Generic chat caching should not outrank provider prompt-cache/account affinity.

## Identity resolution

| Requested name | Exact first-party identity | Version inspected | Correct scope |
|---|---|---:|---|
| Switchboard | Local repository; [Vijay-Duke/switchboard-router](https://github.com/Vijay-Duke/switchboard-router) | 0.6.31 | Local-first Next.js dashboard and compatibility gateway (`README.md:1-8,120-138`). |
| 9Router | [decolua/9router](https://github.com/decolua/9router); [v0.5.35](https://github.com/decolua/9router/releases/tag/v0.5.35) | 0.5.35 release | **Ancestor/upstream baseline, not an independent competitor.** Local first-party evidence says Switchboard was rebranded from 9Router and names this upstream (`.github/SECRETS.md:36-39`); the license still credits decolua (`LICENSE:1-4`) and data-directory code adopts legacy 9Router state (`src/lib/dataDir.js:5-34`). Only explicit post-divergence differences count. Its current scope is the same local coding router ([README](https://raw.githubusercontent.com/decolua/9router/master/README.md)). |
| CLIProxyAPI | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI); [v7.2.139](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.139) | 7.2.139 | Direct Go engine alternative: OpenAI/Gemini/Claude/Codex/Grok-compatible proxy with multiple CLI accounts ([README](https://github.com/router-for-me/CLIProxyAPI#overview)). |
| EasyCLI | The old [router-for-me/EasyCLI](https://github.com/router-for-me/EasyCLI) URL resolves to [router-for-me/EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI); [v0.2.56](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.2.56) | 0.2.56; bundled core 7.2.138 | Tauri desktop manager **for CLIProxyAPI**, not another proxy core. It handles lifecycle, OAuth, usage, updates, and agent configuration around the core ([README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md), [core version](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/core-version.txt)). |
| LiteLLM | [BerriAI/litellm](https://github.com/BerriAI/litellm); [v1.97.0](https://github.com/BerriAI/litellm/releases/tag/v1.97.0) | 1.97.0 plus current docs | Established organizational gateway baseline for routing, governed keys, caching, telemetry, MCP, and endpoint breadth. |
| New API | Canonical [QuantumNous/new-api](https://github.com/QuantumNous/new-api); [v1.0.0-rc.25](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.25) | 1.0.0-rc.25 plus current docs | Multi-user model hub/gateway baseline for quotas, realtime/rerank, and multi-node deployment ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)). |

EasyCLIProxyAPI must not be counted as “CLIProxyAPI plus another gateway.” 9Router must not be counted as an unrelated competitor. These identity corrections materially change the analysis.

## Status legend

- **I — Implemented:** concrete implementation and call path found.
- **P — Partial:** useful subset exists, broader capability does not.
- **A — Absent:** implementation surface/schema/routes were checked, not inferred from marketing.
- **U — Unknown/not verified:** primary evidence did not establish it; unknown is not absent.
- **N/A:** wrapper/control surface rather than gateway core.

## Capability matrix

Every external capability claim links to a first-party source.

| Capability | Switchboard | CLIProxyAPI | EasyCLIProxyAPI | 9Router lineage | LiteLLM | New API |
|---|---|---|---|---|---|---|
| Unified compatibility gateway | **I** — chat, Messages, Responses, Gemini, embeddings, images/audio, search/fetch route tree (`src/app/api/v1/**/route.js`, `src/app/api/v1beta/models/**/route.js`) | **I** ([README](https://github.com/router-for-me/CLIProxyAPI#overview)) | **N/A; via core** ([README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md)) | **I/shared lineage** ([README](https://raw.githubusercontent.com/decolua/9router/master/README.md)) | **I** ([endpoints](https://docs.litellm.ai/docs/supported_endpoints)) | **I** ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)) |
| Multi-account pool and failover | **I** (`src/sse/services/auth.js:39-214`; handler exclusion/retry loops) | **I** — multi-account round-robin ([README](https://github.com/router-for-me/CLIProxyAPI#overview)) | **I via core** ([README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md)) | **I/shared lineage** ([README](https://raw.githubusercontent.com/decolua/9router/master/README.md)) | **I** ([routing](https://docs.litellm.ai/docs/routing)) | **I** — weighted channels/retry ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)) |
| Session affinity, inflight/capacity-aware account scheduler | **P** — explicit pin and sticky request-count rotation, but no automatic session binding, least-inflight scoring, or per-account cap input (`src/sse/services/auth.js:1-214`, `src/lib/db/repos/usageRepo.js:175-215`) | **I** — session affinity, credential concurrency/inflight observation, retry rounds ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **I via core** ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **U**; only provider-specific Kiro cache reuse verified ([v0.5.35](https://github.com/decolua/9router/releases/tag/v0.5.35)) | **I** — rate-limit aware, least-busy, weighted, latency/cost routing ([routing](https://docs.litellm.ai/docs/routing)); affinity configurable/off by default in v1.97 ([release](https://github.com/BerriAI/litellm/releases/tag/v1.97.0)) | **P/U** — weighted channels/user limits, affinity unverified ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)) |
| Per-account outbound proxy | **I** — legacy connection fields survive; pools intentionally removed (`src/lib/network/connectionProxy.js:1-79`, `src/sse/services/auth.js:173-205`, `open-sse/utils/proxyFetch.js:426-480`) | **I** — global and per-entry proxy URLs ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **I via core** ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **U** | **U** | **U** |
| Cooldown/circuit-breaker behavior | **P** — classified fallback, exponential 429 backoff, persisted per-model locks and precise resets; no formal open/half-open machine (`open-sse/services/accountFallback.js:1-254`, `src/sse/services/auth.js:217-284`) | **I** — retry rounds, cooling controls, optional persisted cooldown ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **I via core** ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **P/I** — auto fallback verified, formal breaker unverified ([README](https://raw.githubusercontent.com/decolua/9router/master/README.md)) | **I** ([routing](https://docs.litellm.ai/docs/routing)) | **P** — retry verified, formal breaker unverified ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)) |
| Provider prompt-cache/account affinity | **P** — stable Codex prompt key and workspace header after selection plus manual connection pin; selector does not bind a session to an account (`open-sse/executors/codex.js:125-144,337-343`, `open-sse/utils/sessionManager.js:190-215`) | **I** — universal session-sticky routing and Codex remapping ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **I via core** ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **P/U** ([v0.5.35](https://github.com/decolua/9router/releases/tag/v0.5.35)) | **I** ([auto routing](https://docs.litellm.ai/docs/proxy/auto_routing), [v1.97](https://github.com/BerriAI/litellm/releases/tag/v1.97.0)) | **U** |
| Gateway response cache | **P** — persistent exact cache for web fetch/search only; no chat/Responses/Messages/embedding call path (`src/sse/utils/fetchCache.js:26-75`, `src/sse/handlers/fetch.js:94-116`, `src/sse/handlers/search.js:74-96`) | **U** | **U** | **U** | **I** — exact/semantic LLM response caches over multiple stores ([caching](https://docs.litellm.ai/docs/proxy/caching)) | **U** — cache accounting is not proof of response caching ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)) |
| Client keys, scopes, limits, budgets | **P/A** — hashed key, name, machine, active flag; no model scope, RPM/TPM, expiry, spend ceiling, user/team (`src/lib/db/schema.js:72-83`, `src/lib/db/repos/apiKeysRepo.js:8-113`) | **P/U** — inbound keys verified; governed budgets unverified ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **P via core** ([README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md)) | **P/U** ([README](https://raw.githubusercontent.com/decolua/9router/master/README.md)) | **I** — virtual keys and enforced key/user/team/org budgets ([access control](https://docs.litellm.ai/docs/proxy/access_control)) | **I** — token groups, model restrictions, users, quotas, rate limits ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)) |
| Prometheus / OTel | **A** — no exporter dependency or metrics route in `package.json`, `src/**`, `open-sse/**`; Grok `traceparent` strings are upstream headers | **P/U** — built-in usage removed; companion services recommended ([README](https://github.com/router-for-me/CLIProxyAPI#usage-statistics)) | **P** — durable local usage, not standard export ([README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md)) | **P/U** ([README](https://raw.githubusercontent.com/decolua/9router/master/README.md)) | **I** — `/metrics` and hashed-key/cache/budget/MCP/provider metrics ([Prometheus](https://docs.litellm.ai/docs/proxy/prometheus)); GenAI OTLP traces ([OTel](https://docs.litellm.ai/docs/observability/opentelemetry_v2)) | **P/U** — dashboard/Pyroscope, Prom/OTel unverified ([environment](https://docs.newapi.pro/en/docs/installation/config-maintenance/environment-variables)) |
| Aggregated MCP gateway | **P** — catalog and client config projection; runtime bridge spawns fixed preset stdio plugins per plugin (`src/lib/agent-library/mcp-store.js`, `src/lib/agent-library/mcp-adapters.js`, `src/lib/mcp/stdioSseBridge.js`) | **U** — native plugins are not MCP evidence ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **U** | **U** | **I** — discovery, allowlisting, execution and response reintegration ([MCP](https://docs.litellm.ai/docs/mcp_usage)) | **U** |
| Realtime, rerank, batches | **A** — no corresponding public routes (`src/app/api/v1/**/route.js`) | **P/U** — streaming/WebSocket verified, named contracts not all verified ([README](https://github.com/router-for-me/CLIProxyAPI#overview)) | **P via core** ([README](https://github.com/router-for-me/CLIProxyAPI#overview)) | **Named trio unverified; video divergence** — `/v1/videos` added after fork ([v0.5.35](https://github.com/decolua/9router/releases/tag/v0.5.35)) | **I** ([endpoints](https://docs.litellm.ai/docs/supported_endpoints)) | **P/I** — realtime/rerank verified, batches unverified ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)) |
| Multi-user/admin | **A, intentional** — explicit single-user/local-only, no login/password/OIDC (`cli/src/cli/menus/settings.js:15-21`; `src/dashboardGuard.js:212-251`) | **U** — remote management is not RBAC evidence ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **A/N/A** — desktop console ([README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md)) | **A/P local scope** ([README](https://raw.githubusercontent.com/decolua/9router/master/README.md)) | **I** ([access control](https://docs.litellm.ai/docs/proxy/access_control)) | **I** ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)) |
| Distributed state/deployment | **A, intentional** — one process and local SQLite; cloud sync/remote hosting removed (`docs/ARCHITECTURE.md:1-20,91-117,164-176`) | **U** — Home/cluster compose exists, state semantics not established ([compose](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/docker-compose.cluster.yml)) | **A/N/A** ([README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md)) | **A/P local scope** ([README](https://raw.githubusercontent.com/decolua/9router/master/README.md)) | **I** — Redis auth/cache shared across workers/replicas ([caching](https://docs.litellm.ai/docs/proxy/caching)) | **I** — shared SQL/secrets, node roles, Redis topologies ([environment](https://docs.newapi.pro/en/docs/installation/config-maintenance/environment-variables)) |
| TLS/client fingerprint impersonation | **P; package U** — source selects Node/Chrome/Claude-Code TLS and dispatches Impit/native uTLS (`open-sse/identity/catalog.js:155-203`, `open-sse/utils/proxyFetch.js:426-466`, `open-sse/identity/tls/claude-code.js`, `open-sse/identity/tls/native/main.go`); manifests do not declare Impit and no platform helper binary/package reference was found | **U** — request cloaking is not TLS proof ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)) | **U** | **U** | **U** | **U** |

## Prior claims corrected

- **Multi-account pooling:** implemented, not missing. `getProviderCredentials()` loads active connections, filters excluded/locked accounts, honors preferred account, applies fill-first/sticky RR, and persists use counters (`src/sse/services/auth.js:39-214`).
- **Per-account proxy:** implemented. `resolveConnectionProxyConfig()` consumes legacy per-connection URL/no-proxy fields; selected credentials carry them into `proxyAwareFetch()`. Proxy **pools** were intentionally removed (`src/lib/network/connectionProxy.js:1-79`).
- **Circuit breaker/cooldown:** substantial breaker behavior exists: classified retryability, exponential backoff, DB-backed per-model locks and reset timestamps. Only a formal closed/open/half-open abstraction is absent (`open-sse/services/accountFallback.js`, `src/sse/services/auth.js:217-284`).
- **Cache affinity:** partial. Provider session/prompt cache identifiers are stable after selection and a client can pin an account, but the selector does not automatically bind a conversation to that account.
- **Response caching:** partial; exact persistent cache only covers web fetch/search, not LLM completions or embeddings.
- **Virtual keys/budgets:** key authentication is implemented and hash-packed. Governance/budgets are absent from the schema.
- **TLS fingerprinting:** current source contains Chrome and Claude-Code transport implementations; packaged availability remains unverified. It is not accurate to call it simply absent.
- **Prometheus/OTel:** absent.
- **Realtime/rerank/batches:** absent as public Switchboard contracts.
- **MCP hub:** partial config-management and preset-bridge capabilities, not a unified MCP gateway.
- **Multi-user/admin:** absent by design.
- **Distributed deployment:** absent by design.

## P0 local security finding: reusable keys stored in usage data

This is more urgent than parity work:

1. Registered keys are packed as one-way digests and returned in full only once (`src/lib/db/repos/apiKeysRepo.js:8-57`).
2. Chat extracts the inbound bearer key and passes it to the core (`src/sse/handlers/chat.js:238-253,757-766`).
3. `saveUsageStats()` forwards it to the repository (`open-sse/handlers/chatCore/requestDetail.js:77-107`).
4. `usageHistory.apiKey` is a text column; the insert writes `entry.apiKey` directly; daily `byApiKey` uses the plaintext value in both its key and metadata (`src/lib/db/schema.js:103-127`; `src/lib/db/repos/usageRepo.js:86-115,281-351`).
5. Read APIs mask it, but that does not protect SQLite at rest (`src/lib/db/repos/usageRepo.js:6-10,391-394`).

A literal call-site audit found this persistence path through chat core; other public handlers do not currently call `saveRequestUsage()` directly.

**Required correction:** attribute usage by key ID or one-way digest plus display prefix; migrate daily aggregates; scrub old history; never emit the bearer secret into logs, request details, metrics or traces. LiteLLM’s metrics explicitly label keys by hash, a useful safe precedent ([official metrics](https://docs.litellm.ai/docs/proxy/prometheus)).

## Material product gaps

### 1. Account Scheduler v2

The per-provider mutex prevents selection-update races, but selection ignores live capacity already tracked by `trackPendingRequest()` (`src/lib/db/repos/usageRepo.js:175-215`). Quota headroom collapses accounts to the **maximum per provider**, useful for Auto’s provider choice but not account choice (`src/lib/db/repos/connectionsRepo.js:127-147`).

CLIProxyAPI documents session-sticky routing, credential concurrency/inflight observation, retry-round filtering and cooldown in its [official config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml). LiteLLM documents least-busy and rate-limit-aware deployment routing ([official routing](https://docs.litellm.ai/docs/routing)).

Build the narrow local version:

1. extract a deterministic conversation/session key before account selection;
2. bind session to connection with TTL and failover rebinding;
3. score fresh per-account quota/reset and current inflight count;
4. support an optional per-connection concurrency ceiling;
5. expose deterministic selection reason in request details;
6. preserve explicit connection pinning and existing model cooldown behavior.

This improves prompt-cache reuse and prevents account stampedes without requiring distributed coordination.

### 2. Standard telemetry export

Switchboard already computes counts, status, latency, tokens/cost, active requests, quota and routing outcomes, but only exposes local SQLite/dashboard/JSON/SSE views. LiteLLM demonstrates interoperable Prometheus metrics ([docs](https://docs.litellm.ai/docs/proxy/prometheus)) and GenAI-semantic OTLP traces ([docs](https://docs.litellm.ai/docs/observability/opentelemetry_v2)).

The Switchboard-sized slice is opt-in and low-cardinality: requests, success/errors, duration, tokens, active requests, fallback/cooldown, cache hit, provider/model/endpoint, and Auto decisions. Use corrected non-secret key identity; keep prompt/response capture off.

### 3. Bounded client-key policy

LiteLLM supports key/user/team attribution and enforced budgets ([docs](https://docs.litellm.ai/docs/proxy/access_control)); New API supports token groups, model restrictions, quota allocation and user-level rate limiting ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)). Switchboard need not copy organizations, SSO or billing. Model/combo allowlists, expiration, RPM/concurrency, and an optional local spend ceiling are enough **only when an operator intentionally shares the endpoint**.

### 4. MCP aggregation

Agent Library config projection is valuable and distinct from a gateway. LiteLLM’s MCP gateway centralizes discovery, allowed tools, execution and response reintegration ([docs](https://docs.litellm.ai/docs/mcp_usage)). A Switchboard hub fits the agent-control-plane direction, but arbitrary stdio execution, secret propagation, tool collisions, authorization and audit make it high-risk. Build only for a named client need, remain loopback-first, namespace every tool, and never accept arbitrary network-supplied commands.

### 5. Endpoint breadth

LiteLLM exposes realtime, rerank and batches ([endpoint list](https://docs.litellm.ai/docs/supported_endpoints)); New API documents realtime and rerank ([README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md)); 9Router added video after divergence ([v0.5.35](https://github.com/decolua/9router/releases/tag/v0.5.35)). Rerank is the only nearby, bounded, stateless candidate. Realtime/WebRTC, managed batches/files and video are separate lifecycle-heavy products, not automatic gaps for a coding gateway.

## Intentional local-first tradeoffs

- **Single user/no RBAC:** minimal setup and credential surface; unsuitable for an organization service.
- **One process/SQLite:** portable and backup-friendly; unsuitable for horizontal replicas.
- **Local observability:** private and lightweight; weak for fleet operation until optional export exists.
- **No default chat cache:** avoids retaining/replaying sensitive, non-deterministic agent output.
- **Fixed runtime MCP presets:** limits remote-code-execution surface; cannot aggregate arbitrary tools.
- **Per-connection proxy without pools:** preserves account-specific egress without a proxy-fleet subsystem.

These are coherent with `docs/ARCHITECTURE.md:1-20,91-145`. The strategy should deepen the local gateway, not recreate LiteLLM or New API.

## Ranked roadmap

Scores: 5 is highest; risk combines implementation, security and migration risk.

### Must-have

| Rank | Improvement | User value | Strategic fit | Risk | Stop condition |
|---:|---|---:|---:|---:|---|
| **1** | Replace plaintext usage keys; scrub/migrate history and aggregates | 5 | 5 | 3 | No durable row, aggregate, log or telemetry field stores a reusable key; historical attribution remains non-secret. |
| **2** | Account Scheduler v2: affinity + least-inflight + caps + per-account quota | 5 | 5 | 4 | Concurrent conversations stay on healthy accounts, caps hold, failover/rebinding is deterministic, selection reason is visible. |

### Optional, demand-driven

| Rank | Improvement | User value | Fit | Risk | Bound |
|---:|---|---:|---:|---:|---|
| **3** | Opt-in Prometheus **or** OTel export | 4 | 4 | 3 | One low-cardinality standard first; hashed key identity; prompts/responses off. |
| **4** | Small per-key policy layer | 3 | 3 | 3 | Allowlists, expiry, RPM/concurrency, optional spend cap; no organizations/billing/SSO. |
| **5** | Aggregated MCP namespace | 3 | 4 | 5 | Only after a concrete client asks; namespaced tools, allowlisted servers, loopback default, no remote arbitrary commands. |
| **6** | Rerank endpoint | 2 | 2 | 2 | Only for an existing provider and named coding/search workflow. |
| **7** | Opt-in exact completion-cache experiment | 2 | 2 | 4 | Only with measurable repeats, privacy controls and explicit provider/model scope; no semantic/default cache. |

### Do not build for parity

| Item | Reason |
|---|---|
| Full multi-user/RBAC/billing | Strategy conflict. Shared organizational gateway users should use/compose with LiteLLM or New API. |
| Distributed Switchboard cluster | Shared DB/cache, locks, scheduler leadership, refresh/cooldown convergence and migrations would erase local portability. |
| Realtime + batches/files + video bundle | Separate transport/state products; require a named client/provider contract. |
| Default generic/semantic chat cache | Sensitive/stale replay risk; provider prompt-cache/account affinity fits better. Keep fetch/search cache. |
| Expanded TLS impersonation/anti-detection | Do not productize evasion. Maintain only lawful, narrowly required compatibility; package/document it explicitly or remove dead paths. |
| Reintroduced proxy pools | Per-connection proxy exists; pools duplicate account scheduling and add network failure modes. |
| Trusted in-process native plugin parity | Supply-chain and memory-safety blast radius; existing provider registry/bounded MCP seams are safer. |

## Recommended sequence

1. Define non-secret key attribution, migrate/scrub history and daily data.
2. Bind session before account selection; integrate existing inflight counts and fresh per-account quota.
3. Add local scheduler reason/affinity/inflight/cooldown visibility.
4. Choose one standard telemetry export based on an explicit operator need.
5. Add bounded key policies only after evidence of shared endpoint use.
6. Treat MCP aggregation and every new endpoint as separate user-requested bets.

## Final positioning

Switchboard’s defensible position is **the deep local coding-agent gateway**: subscription/API account routing, protocol translation, adaptive model choice, token-saving tools, agent configuration, and a private local control plane. CLIProxyAPI is the closest engine comparator and currently sets the stronger account-scheduler baseline ([config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml)). EasyCLIProxyAPI sets a stronger native desktop packaging/update baseline—portable/offline core install, durable usage subscription, rollback updates and agent config backup/restore ([README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md)). LiteLLM and New API demonstrate enterprise breadth, but copying their multi-user/distributed architecture would be a strategy change, not a gap fix.

The pragmatic win is: **never leak the client key; keep each conversation on the right healthy account; avoid account stampedes; preserve provider caches; make the behavior observable.**

## Primary source index

### Local

`package.json`; `README.md`; `.github/SECRETS.md`; `LICENSE`; `src/lib/dataDir.js`; `docs/ARCHITECTURE.md`; `src/sse/services/auth.js`; `open-sse/services/accountFallback.js`; `src/lib/network/connectionProxy.js`; `open-sse/utils/proxyFetch.js`; `src/lib/db/schema.js`; `src/lib/db/repos/apiKeysRepo.js`; `src/lib/db/repos/usageRepo.js`; `src/lib/db/repos/connectionsRepo.js`; `src/sse/utils/fetchCache.js`; `src/sse/handlers/fetch.js`; `src/sse/handlers/search.js`; `open-sse/executors/codex.js`; `open-sse/utils/sessionManager.js`; `src/lib/agent-library/mcp-store.js`; `src/lib/agent-library/mcp-adapters.js`; `src/lib/mcp/stdioSseBridge.js`; `open-sse/identity/catalog.js`; `open-sse/identity/tls/claude-code.js`; `open-sse/identity/tls/native/main.go`.

### External

- [CLIProxyAPI repo](https://github.com/router-for-me/CLIProxyAPI), [release](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.139), [config](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml), [cluster compose](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/docker-compose.cluster.yml).
- [EasyCLIProxyAPI repo](https://github.com/router-for-me/EasyCLIProxyAPI), [README](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/README.md), [release](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.2.56), [core version](https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/core-version.txt).
- [9Router repo](https://github.com/decolua/9router), [README](https://raw.githubusercontent.com/decolua/9router/master/README.md), [release](https://github.com/decolua/9router/releases/tag/v0.5.35).
- [LiteLLM repo](https://github.com/BerriAI/litellm), [release](https://github.com/BerriAI/litellm/releases/tag/v1.97.0), [routing](https://docs.litellm.ai/docs/routing), [access](https://docs.litellm.ai/docs/proxy/access_control), [caching](https://docs.litellm.ai/docs/proxy/caching), [Prometheus](https://docs.litellm.ai/docs/proxy/prometheus), [OTel](https://docs.litellm.ai/docs/observability/opentelemetry_v2), [MCP](https://docs.litellm.ai/docs/mcp_usage), [endpoints](https://docs.litellm.ai/docs/supported_endpoints).
- [New API repo](https://github.com/QuantumNous/new-api), [README](https://raw.githubusercontent.com/QuantumNous/new-api/main/README.en.md), [release](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.25), [environment/multi-node docs](https://docs.newapi.pro/en/docs/installation/config-maintenance/environment-variables).
