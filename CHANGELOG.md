# v0.9.12 (2026-09-06)

## Features
- **Qwen Code card**: the Qwen Code OAuth provider is no longer hidden from the dashboard provider list. Coding-plan users can sign in via the chat.qwen.ai device flow with automatic token refresh, instead of pasting short-lived `sk-sp-…` access tokens into the Alibaba API-key cards (where they are rejected as invalid keys).

# v0.9.11 (2026-09-04)

Second full-application review: eight exhaustive code reviews (dashboard core, dashboard operations, dashboard tools, API routes, request translators, response translators, engine, library/CLI, stream core) plus a hands-on walkthrough of the live dashboard. Roughly 430 findings were fixed, every fix ticket was independently gate-reviewed, and around 900 tests were added.

## Fixes
- **Model picker**: searching by provider name (for example `cro` for CrofAI) no longer hides that provider's models; the search matches the `provider/model` value, autofocuses, shows "N of M", has an empty state, and the list no longer resizes the dialog. Live-discovered models are no longer badged "custom"; the list container no longer claims an invalid `listbox` role.
- **Dashboard navigation**: sidebar links no longer prefetch every route on each navigation (that storm queued API calls for 10+ seconds and left Overview tiles at 0); Overview shows placeholders until stats arrive. `/api/version` is cached server-side for an hour and fetched once per page; Header and Sidebar share one gateway-health poll; the Console page reports "connected" as soon as the stream opens; the Providers list orders connected, then available, then disabled; the dead theme selector is gone from Settings; MITM defaults to `127.0.0.1`.
- **Usage**: the "Usage by Model" table shows the provider column; the request-detail drawer fetches the full unredacted record via a new `GET /api/usage/request-details/[id]` instead of rendering `{"redacted": true}`; filters reset to page 1 and ignore stale responses; ProviderLimits mutations surface HTTP errors; quota sorting no longer produces NaN; the quota table keeps its page across auto-refresh; chart/table error and expand states are correct; routing-insights filters apply to every panel; timestamps render in local time.
- **Providers and combos**: bulk delete keeps failed rows; priority swap, node update, and provider toggle report failures and revert; cookie-auth forms require a credential; Kiro auth modals reset on close; the changelog modal guards an empty URL; copy-to-clipboard reports failure instead of a false "Copied!"; `reauth_required` renders as an error status; capacity-adapter pools longer than three models are editable; provider strategy inputs commit on blur instead of every keystroke; language switching no longer flashes the old flag.
- **Agent library, CLI tools, media**: card header toggles are keyboard-accessible; eight tool cards now seed their endpoint selector from the saved server URL; the Codex config parser no longer drops the last character of the final section; Codex, Droid, and OpenClaw routes default the key to `sk_switchboard` instead of a literal placeholder; the Cowork route validates and normalises the base URL and keeps managed MCP servers; disconnecting Codex consumes its backup; the removed Antigravity card is gone; skills pages reset content between skills; media example cards guard empty input and report copy/delete failures; pxpipe and MITM pages refresh state correctly.
- **Management and dashboard APIs**: `POST /api/mgmt/v1/combos` and `PUT /api/mgmt/v1/combos/[id]` now enforce the management token they were only computing; 5xx responses no longer echo raw error text; malformed JSON bodies return 400 on models and translator routes; `usage/history` honours `period`; `pricing` DELETE without a provider no longer wipes all custom pricing; `/v1/models` entries carry `created`; the Gemini `v1beta` route delegates to the registered translator (its hand-rolled converter emitted empty user turns); shutdown route works on Next 16; sticky round-robin limits are clamped server-side; the default API key is find-or-create.
- **Translators**: Gemini tool results are wrapped once (`{result: …}`), parallel same-name calls get stable paired ids, `functionCall` keeps its id (dropping it stripped every tool result), tool_choice/temperature/stop/top_p/top_k/`max_completion_tokens` map correctly, `developer` role reaches Claude, `is_error` and document blocks survive, sampling parameters are clamped per provider range, `parallel_tool_calls=false` maps to native flags instead of trimming history, Responses API reasoning buffering and multi-system handling are correct, the Responses→Chat bridge routes parallel tool-call arguments by `call_id` (not `item_id`), Claude `redacted_thinking` and web-search results no longer leak ciphertext or stray `</think>` into visible text, Ollama tool-call ids are unique across turns, and unknown finish reasons map to `stop`.
- **Engine**: Gemini CLI headers read the live identity snapshot and honour `RetryInfo`; Azure uses `AZURE_API_KEY`; Cursor and Kiro error frames are classified; nested Auto→combo→Auto chains stop at the depth cap end to end; fusion isolation; a 503 gets one bounded same-model retry; format detection scans structural blocks only; Claude cloaking covers server tools; the Ollama transform decodes UTF-8 across chunks and terminates on error; the model-catalog generator handles case-variant keys and the catalog was regenerated; the identity poller discards snapshots that belong to another profile (the Gemini CLI file had been pinned to Codex's version).
- **Stream core**: CRLF and multi-line SSE frames, multi-choice JSON assembly, abort handling in SSE→JSON conversion and transient-retry peeks, bounded non-streaming body reads, `response.failed` before `[DONE]`, per-connection proxy options on every media hop, Claude identity gate restored (a caller User-Agent no longer overrides an explicit profile), image/embedding/TTS/STT/video/search cores validate input, cap sizes (413), time out upstream calls, propagate abort signals, escape SSML, and validate URLs.
- **Library and CLI**: request-detail flushes run before adapter close on shutdown and the SIGTERM handler no longer races the app's own graceful shutdown; config import allowlists keys and checksum-gates re-imports; the MITM logger redacts secrets; the interface menu handles ESC; xAI video command validates input; standalone/catalog/registry scripts validate arguments and write atomically; the Windows tray reports readiness.
- **Windows**: the sql.js adapter could never persist on Windows (it fsynced a read-only handle); DB flush now also runs on `process.exit` and SIGBREAK; the full unit suite now runs on Ubuntu, Windows, and macOS in CI and passes on all three.

## Notes
- Muse was retired as the implementation worker mid-batch; the dashboard-tools tickets were implemented by GLM 5.3 through the gateway. Every ticket regardless of worker was gate-reviewed by Fable, and every gate found and fixed at least one defect in the worker output.

# v0.9.10 (2026-09-03)

## Fixes
- **Codex transport stability**: use `responses_websocket` by default to avoid OpenAI's 30-second HTTP SSE cap, let WebSocket EOF close translated streams normally, and retain `CODEX_WS_TRANSPORT=off` plus pre-output HTTP fallback.
- **Gateway crash recovery**: retry unexpected server exits with exponential backoff capped at 30 seconds; stable runs reset the backoff, restarts stay unbounded once the server has been healthy, the launcher gives up after 5 consecutive boot failures that never became healthy, and repeats of an unchanged crash log are suppressed after 10 attempts.
- **Codex WebSocket hardening**: the WS hop now applies the `codex-cli` identity snapshot to the upgrade headers, honours per-connection proxies, `HTTPS_PROXY`, and the Vercel relay via an undici dispatcher (strict-proxy and MITM-bypass cases fall back to HTTP), waits for the first frame before treating the socket as ready (an error frame such as a 429 quota rejection now falls back to HTTP so account rotation and cooldowns work), applies a connect timeout, no longer sends compaction requests over WS, keeps the fallback body pristine, buffers frames with backpressure, and opens a per-proxy circuit breaker (3 handshake failures → HTTP-only for 5 minutes).
- **Responses `response.incomplete`**: recognised as a terminal event across the WS transport, passthrough, and the Responses→Chat translator (`finish_reason: length` or `content_filter`), and its usage is logged. Truncated Codex turns no longer hang or get reported as failures.
- **Usage hot path**: the usage SSE stream no longer recomputes the all-time report per request; Auto/provider-bias reads a cached 7-day provider count; `lastUsed` overlays are one aggregated query with a new covering index; `cachedTokens` is denormalised on `usageHistory`; usage persistence no longer blocks the response for unkeyed requests (keyed requests still await it so spend caps stay exact); request-detail serialisation is memoised; `ENABLE_REQUEST_LOGS` uses buffered write streams; retention trims via an index seek; settings/pricing/metrics probes are memoised; API-key verification caches a scrypt result for 60 s; the Claude TLS helper keeps a small pre-spawned pool (`SWITCHBOARD_CLAUDE_TLS_POOL_CAP`, default 2, `0` disables).
- **DB init retry + health readiness**: a failed adapter init no longer poisons the process; `/api/health` returns 503 when the DB cannot answer `SELECT 1`, so the launcher watchdog restarts a wedged server.
- **Launcher**: probes and the Terminal UI carry the CLI token so `--host <LAN IP>` no longer self-kills every 90 s; exited children are never signalled (PID reuse) while their orphaned process group is swept; the watchdog survives callback errors; tray/hidden mode detaches terminal output so a closed terminal cannot wedge Quit; the LaunchAgent logs under the data dir instead of `/tmp`.
- **Updater relaunch**: relaunch runs the freshly installed global `cli.js` under the current runtime (the old `npx switchboard-router` form always failed on the two-bin package). The tray binary fallback verifies the npm `dist.integrity` sha512 and honours `DATA_DIR`.
- **Dashboard local-only guard**: `/dashboard/*` pages are gated like `/api/*` (peer, Host, Origin, `SWITCHBOARD_LOCAL_PEERS`, CLI token), and server-rendered settings omit `mitmSudoEncrypted` and `ssrfAllowHosts`.
- **Secrets at rest**: new blobs are sealed as `enc:v2:` with a key derived from `auth/data-key` and the per-install `auth/cli-secret`; existing `enc:v1:` blobs stay readable and migrate on their next write. The MITM sudo password is re-sealed on first use and its value never appears on the `sudo` command line.
- **OAuth**: authorization `state` is bound server-side (10-minute TTL) for PKCE providers; raw pasted access tokens are accepted only for providers that declare `acceptsRawAccessToken` and pass issuer checks; permanent refresh failures (`invalid_grant` and friends) are classified for every provider, retried once instead of three times, and mark the connection `reauth_required` so the Providers page shows the reconnect prompt.
- **Agent Library projection**: Codex per-tool config keeps native types (`output_token_limit = 4000`, not a string that bricked `config.toml`), `env_vars`/`env_http_headers`/`bearer_token_env_var` replace literal `${VAR}` placeholders for Codex, Cursor gets `${env:NAME}` and `type: "stdio"`, `~/.claude.json` merges re-read on concurrent writes and keep the file's indentation, OpenCode skips skills already covered by Claude/Codex roots, and omp has an explicit branch.
- **`/v1/messages/count_tokens`**: proxied to Anthropic-format providers with the Claude identity (10 s timeout) instead of a chars/4 estimate; image blocks are estimated at a flat ~1600 tokens in the fallback.
- **Dashboard UX**: update-countdown Cancel actually cancels; Overview shows a load-error banner instead of "connect your first provider" when the DB fails and drops the always-empty Quota widget; mutations surface server errors as toasts; toasts are announced to assistive tech; Agent Library feedback moved to toasts and the active tab is written to the URL; route-level loading skeletons; a live online/offline gateway indicator; the no-op Theme menu item is gone; nav has `aria-current`, no duplicate CLI tools link, and Chat is reachable; muted text meets WCAG AA; `prefers-reduced-motion` is honoured; tooltips and the search field are keyboard/screen-reader accessible; zh-CN nav labels are translated and `check:i18n` now fails on missing nav strings.
- **Docs**: `docker run` quick starts create the `switchboard` network the peer allowlist assumes; `ENVIRONMENT.md` documents `MANAGEMENT_TOKEN`, `HOST`, `UPDATER_STARTUP_TIMEOUT_MS`, and retires `SWITCHBOARD_DATA_DIR`.

# v0.9.9 (2026-09-02)

## Features
- **Claude Code 2.1.258 identity**: refresh the measured interactive Claude CLI tuple (`cc_version`, Stainless package/runtime, beta order, headers, and HTTP/1.1 ClientHello) and regenerate every platform TLS helper with the native X25519+ML-KEM key share.

## Fixes
- **Gateway self-recovery**: the long-lived CLI parent now probes `/api/health`, terminates only its owned server process after three consecutive failures, and respawns it without double-start races.
- **Codex transport stability**: keep HTTP SSE as the default and make `responses_websocket` explicit via `CODEX_WS_TRANSPORT=on`; failed, aborted, and completed WebSocket paths now close their native resources exactly once.

# v0.9.8 (2026-08-31)

## Features
- **Agent Library: Oh My Pi (omp) target** — the Agent Library now projects skills and MCP servers into omp/pi (`~/.pi/agent/skills`, `~/.pi/agent/mcp.json`, project-scope `<project>/.pi/mcp.json`), alongside Claude Code, Codex, OpenCode, Gemini CLI, and Cursor. MCP-only Codex tunables survive a round trip: `startupTimeoutSec`/`toolTimeoutSec` and per-tool config (`tools: { evaluate: { approval_mode: "approve" } }`) are stored in the library and re-emitted as `startup_timeout_sec`/`tool_timeout_sec` and `[mcp_servers.<id>.tools.<name>]` TOML subtables; JSON targets ignore them.

## Fixes
- **Codex responses_websocket transport**: OpenAI capped the legacy HTTP SSE path at 30 seconds (long streams died with `reqwest Body TimedOut` and clients saw unexpected socket closes). The codex executor now streams full responses over the official WebSocket transport — one `response.create` frame in, Responses events bridged to SSE out — with automatic fallback to HTTP on handshake failure. Disable with `CODEX_WS_TRANSPORT=off`.

# v0.9.7 (2026-08-31)

## Fixes
- **OMP stream transport closure**: close the client SSE stream immediately after the terminal `[DONE]` sentinel on translated Codex Responses streams (usage + completion bookkeeping runs at that seam). OMP/Bun no longer waits on an open HTTP body and reports an unexpected socket close.

# v0.9.6 (2026-08-31)

## Fixes
- **OMP terminal event delivery**: emit OpenAI `data: [DONE]` as soon as a translated Codex Responses terminal event arrives, before upstream EOF, so later socket closure cannot trigger OMP/Bun retries.

# v0.9.5 (2026-08-28)

## Features
- **Featured Executor.sh MCP Gateway Preset**: 1-click integration for Executor.sh (`npx -y executor mcp`) in the Agent Library MCP tab ([/dashboard/agent-library](http://127.0.0.1:20128/dashboard/agent-library)), projecting a unified tool execution gateway (OpenAPI, GraphQL, MCP, sandboxed JS) across Claude Code, Codex, Gemini CLI, OpenCode, and Cursor.
- **Popular MCP Server Presets**: 1-click presets for Filesystem MCP (`@modelcontextprotocol/server-filesystem`), GitHub MCP (`@modelcontextprotocol/server-github`), and Fetch MCP (`@modelcontextprotocol/server-fetch`) with prefill customization.

## Fixes
- **OMP streaming termination**: emit the OpenAI `data: [DONE]` sentinel when translating Codex Responses streams to Chat Completions, preventing OMP/Bun from waiting 30 seconds and reporting an unexpected socket close.

# v0.9.4 (2026-08-28)

## Features
- **Smart Skill Import & CLI Command Resolver**: Support pasting commands (e.g. `npx skills add citrolabs/ego-lite`), repository shorthands (`citrolabs/ego-lite`, `citrolabs/ego-lite@branch`), GitHub web/tree/blob URLs, and direct raw URLs directly into the Agent Library Catalog.
- **GitHub Repository Tree Auto-Discovery**: Automatically discover `SKILL.md` files across repositories (with multi-skill picker for monorepos like `anthropics/skills`) using GitHub tree discovery with candidate probing fallbacks.
- **Interactive Previews & Instant Multi-Harness Sync**: Live `SKILL.md` previewing with frontmatter parsing, security confirmation guards, and 1-click post-install Apply Sync to project skills across Claude Code, Codex, Gemini CLI, OpenCode, and Cursor.
- **Skills Page & Catalog Guidance Enhancements**: Added cross-harness guidance banners on `/dashboard/skills` pointing to the Agent Library, along with 1-click quick-try sample chips on the Catalog tab.

# v0.9.3 (2026-08-27)

## Features
- **Protocol Endpoints Hub**: Comprehensive Protocol Endpoints card (`/dashboard/endpoint`) with tabbed breakdown for OpenAI (`/v1/chat/completions`, `/v1/responses`, `/v1/models`), Claude (`/v1/messages`), Gemini (`/v1beta/models/{model}:generateContent`), Media (TTS, STT, Embeddings, Images, Videos), and CLI code snippets
- **Endpoint Guidance & 1-Click Copy**: Added endpoint banners and 1-click copy action buttons across all media modality pages (`/dashboard/media-providers/[kind]`), web search/fetch (`/dashboard/media-providers/web`), Overview (`/dashboard`), Skills prompt (`/dashboard/skills`), and Console Logs (`/dashboard/console-log`)
- **Unified Basic Chat**: Integrated Combos and Auto Routing into Basic Chat (`/dashboard/basic-chat`)
- **Provider Onboarding Enhancements**: Added cookie authentication input, OAuth guidance, and Get API Key links in `/dashboard/providers/new`

## Fixes
- **Claude-to-OpenAI Multimodal Tool Results**: Extracted base64/URL image blocks in `CLAUDE_BLOCK.TOOL_RESULT` to preserve screenshots and multimodal tool returns across the OpenAI bridge
- **OpenAI-to-Cursor Multimodal Array Messages**: Retained image parts in user message arrays during OpenAI to Cursor translation
- **OpenAI-to-CommandCode Tool Arguments**: Preserved raw tool arguments on non-JSON input in `safeParseJson` and preserved image structures
- **Cold-Start Messages Route Fix**: Added missing `initTranslators` import in `src/app/api/v1/messages/route.js`
- **Antigravity MITM & Unit Test Hardening**: Fixed missing `vi` import in `tests/unit/verify-job.test.js` and ensured 100% strict `no-undef` compliance

# v0.9.2 (2026-08-27)

## Fixes
- **omp/Pi live model discovery**: dashboard Pi integration now writes `~/.pi/agent/models.yml` (omp ≥ v18's canonical config, previously only legacy `models.json` was written) with `discovery: openai-models-list`, so every live Switchboard model appears in omp's picker without a dashboard round-trip; dashboard Apply also invalidates omp's 24h discovery cache, and Disconnect restores both files (legacy single-file backups still restore correctly)

# v0.9.1 (2026-08-27)

## Features
- **Multi-Account Routing Strategies**: user-selectable multi-account strategy control (`Fill-First` priority spillover, `Round Robin` sequential load-smoothing with sticky counts, and `Balanced` least-concurrency with session affinity)
- **Wildcard & Glob Model Aliasing**: support glob alias patterns (`gpt-4*`, `claude-3-7*`, `*-flash`, `combo-*`) with prefix and pattern matching
- **Declarative Config Importer**: startup auto-importer (`config.yaml`/`config.json`) supporting seed import of provider connections, model aliases, combos, API keys, and settings for headless and Docker deployments

## Fixes
- **CLI Tools & Settings Body Hardening**: safe JSON parsing and 400 responses across all CLI tools settings endpoints (`aider`, `cline`, `codex`, `cowork`, `deepseek-tui`, `droid`, `gemini-cli`, `grok`, `hermes`, `jcode`, `kilo`, `openclaw`, `opencode`, `pi`), keys, and settings
- **Provider Connection Priority Sorting**: use nullish coalescing for priority assignment so 0-indexed priorities are preserved rather than converted to default 999
- **Provider Model Availability Resolution**: resolve aliases uniformly via `resolveProviderId` in `/v1/models` availability checks

# v0.9.0 (2026-08-23)

## Features
- **OpenCode Go**: route models through their native OpenAI, Claude, or Responses transports with per-model fallback
- **Self-hosted modalities**: add connection-backed STT, TTS, and embedding providers with explicit HTTP(S) endpoints and optional API keys
- **Grok Build**: add device OAuth, token refresh, live models, usage, official client identity, and Responses transport for Grok subscription accounts

## Fixes
- **Streaming retries**: retry known transient SSE overload errors only before meaningful output, with bounded byte-exact replay
- **Provider reliability**: preserve connection proxies during Grok refresh, bound optional usage metadata, forward self-hosted cancellation, and invalidate closed OAuth device flows

# v0.8.1 (2026-08-23)

## Fixes
- **Claude identity assets**: resolve bundled identity snapshots and TLS helpers from runtime-relative paths so standalone builds can fetch usage without reporting an identity mismatch

# v0.8.0 (2026-08-23)

## Features
- **SSRF search guard**: outbound search/fetch tooling validates resolved upstream addresses against private/link-local ranges before connect, fail-closed on DNS ambiguity
- **Request-details redaction**: authorization/api-key headers and credential material are redacted before request details are persisted and surfaced in the usage Request Details tab
- **Capacity adapter**: per-model capacity/capability metadata adapter for the model picker (modality badges via `getCaps`); Hermes attachments are forwarded verbatim when the adapter is off — non-vision models may reject them (documented risk)
- **Usage quota trackers**: extended provider quota tracking with background token-quota refresh (rotation-safe apply), Ollama usage accounting, and soft-failure cache release so tokens recover from transient OAuth/legacy endpoint errors without restart
- **PXPIPE token saver**: opt-in compression of bulky Claude-format prompts into dense multimodal encodings via the `pxpipe-proxy` library API — fail-open engine with min-size/timeout gates, in-process loader, JSONL stats with windowed dashboard (`/dashboard/pxpipe`), setup/health controls on the Token Saver page, and per-request summaries in usage request details
- **Session-colored logging**: unified request-lifecycle log tags (`open-sse/utils/logTags.js`) print one colored tag per request across start/upstream/fallback/done/disconnect/error lines
- **Videos**: `/v1/videos` generation proxy routes with core/app handlers, `switchboard xai video` CLI command, and `grok-imagine-video` in the xAI registry
- **Headroom extras**: extras detection with pip install/uninstall and managed restart, plus dashboard extras management UI
- **Proactive token refresh**: background OAuth refresh before expiry; refresh_token rotates between retry attempts
- **Capacity pools**: combos port capacity adapter pools with vision/audio default-enable; hidden capability pools survive settings edits
- **Endpoint auto-provisioning**: a default API key is provisioned on first run
- **Usage force flag**: wired through the client and usage route to bypass caches on demand
- **Dashboard error boundary**: recoverable per-segment error boundary instead of full-page failure

## Fixes
- **h2c downgrade**: JBR-style `Upgrade: h2c` requests are served as clean HTTP/1.1 — upgrade/HTTP2-Settings headers scrubbed and `Connection: close` forced; emit-hook replay retained as fallback
- **Claude quota**: settled soft-failure promise placeholders are released from the usage cache instead of pinning a token to a stale error until restart (upstream parity fix)
- **Video routes**: wildcard CORS removed from all video proxy endpoints
- **Translator**: mid-conversation system blocks fold into the preceding user turn for cache stability (upstream-verified behavior); tests aligned accordingly
- **Codex reset windows**: routing honors precise codex reset windows and self-reported exhaustion before scheduling an account
- **Command Code**: connection test against the Command Code provider is supported
- **Dashboard**: real runtime port is served before hydration; completed memo dependency arrays in ModelSelectModal
- **Kimi OAuth**: device id persists across the oauth flow and executors, minted device id forwarded through the poll circuit, and the kimi-coding usage handler is registered
- **PXPIPE**: restored requestId wiring, ported `/api/pxpipe/logs` honoring token-saver opt-out, and cache-busted module reloads by content
- **Capacity**: history trimmed to fit the adapter context window; input-modality caps exposed to the model picker UI
- **SSRF hardening**: literal parsing rejects shorthand/full-form evasions, resolved IPs are rechecked against the guard before fetch, and override fetches reject redirects
- **Identity wrap**: dashboard-route identity wrap cutovers completed
- **Claude**: passthrough cache breakpoints re-anchor with 1h TTL; global header cache removed and `anthropic-beta` gated by model; temperature dropped for all Claude models
- **Translator**: `prompt_cache_key` preserved converting chat→responses; empty `tool_calls` arrays no longer close the message; JSON Schema keywords Gemini lacks are dropped
- **Integration/quota fixes**: quota registry flags, video endpoint path, and hub card alignment
- **CI**: standalone pack guard no longer false-positives on the Next.js 16 nested layout; gitbook audit gate cleared via patched postcss pin

# v0.7.0 (2026-08-22)

## Features
- **Client-key security**: replace plaintext gateway-key usage attribution with non-secret key IDs (migration 8); scrub historical usage; salted scrypt verifiers; indexed digest lookup; bounded per-key model/combo allowlists, expiration, request-rate, concurrency, and spend policies with stream-safe leases on every provider-work handler
- **Account Scheduler v2**: opt-in per-provider balanced scheduling with client-key/provider/session-scoped affinity, least-inflight selection, fresh per-account quota scoring, per-connection best-effort concurrency caps, deterministic tie-breaking, failover rebinding, and visible selection reasons; exact in-flight tracking across chat, embeddings, image, STT/TTS, search, fetch, and native Gemini
- **Prometheus metrics**: opt-in authenticated `/api/mgmt/v1/metrics` endpoint with bounded materialized aggregates (migration 9), strict numeric validation, corrupt-state atomic 503, fixed low-cardinality metric families, and single-flight collection
- **TLS transport**: prebuilt Claude Code TLS helper binaries for all six platform/arch targets
- **CORS**: compatibility API preflight now reflects the requesting Origin
- **Basic Chat**: post to gateway `/v1/chat/completions` with user-facing model IDs; add New conversation action; Stop marks cancelled turns; icon actions have human-readable names
- **Accessibility**: shared Modal/Drawer dialog semantics with focus trap, Escape close, and focus return; keyboard-operable sortable table headers, expandable rows, auto-refresh switches, combo model editors, and MITM tool expanders; associated form labels across provider, media, and settings surfaces; named icon-only actions with row context; usage tabs/periods/pagination expose programmatic state; mobile nav Escape dismissal; visible error states for console-log disconnect, translator validation, usage fetch failures, and inverted date ranges

## Fixes
- **Ollama**: preserve assistant content in non-streaming `/v1/api/chat` responses
- **Models**: `/v1/models/info` resolves advertised active models; `/v1/models/llm` accepts the `llm` kind; `/v1beta/models` includes active local models
- **Management**: unauthorized responses carry `Cache-Control: no-store`
- **Theme**: light selection now removes the `dark` class from `documentElement`
- **DB**: shared SQLite shutdown listener registry prevents EventEmitter leaks; legacy JSON import is retryable across restarts, seeds durable spend, and sanitizes all migration backups payload-locally without cross-copying verifiers
- **Packaging**: standalone build copies `.next/static` and `public` alongside custom-server; Vitest and ESLint exclude nested worktrees
- **Translator**: fix `setContents` state wiring so editor input reaches Format and Send
- **Pi**: preserve non-Switchboard providers in `enabledModels` after Apply

# v0.6.31 (2026-08-17)

## Fixes
- **GLM / Import models**: treat Anthropic and Z.AI catalog `type: "model"` as llm so live models show on the provider page instead of disappearing after import

# v0.5.20 (2026-07-07)

## Features
- **Thinking**: per-model thinking level picker on provider page — appends `(level)` suffix to copied model names for forced reasoning effort across all formats (openai, claude, gemini, deepseek, kimi, qwen, zai, minimax, hunyuan, step)
- **RTK**: add JS-native git-log filter (#2423)
- **Caveman**: add targeted upstream-aligned style rules (#2424)
- **i18n**: add Farsi (fa) language support (#2385)

## Fixes
- **Thinking**: strip `(level)` suffix from upstream `body.model` so providers no longer reject requests
- **Translator**: preserve developer instructions in openai-responses conversion (#2434)
- **count_tokens**: count structured Anthropic blocks (#2419)
- **Volcengine-ark**: clamp GLM-5 max_tokens to model output ceiling (#2428)
- **Kimi**: normalize reasoning_effort to backend enum (#2427)
- **Claude**: reconcile max_tokens vs thinking budget and lift per-model ceiling (#2381)
- **Kiro**: deliver system prompt natively, add Opus 4.5/4.7/4.8, tolerate dash version ids (#2366)
- **Headroom**: proxy dashboard through app (#2372)
- **MITM**: recover from stale lock file on server start

# v0.5.18 (2026-07-03)

## Features
- **Usage**: track cached tokens + correct input/output/cache cost (#2209) — hodtien
- **Codex**: show reset credit expiry details (#2290) — Rafli Ahmad Zulfikar
- **NVIDIA**: add new models and capabilities — decolua
- **ClinePass**: add provider support — sternelee

## Fixes
- **Usage**: dedupe streaming request-details log entries — Qin Li
- **Claude**: drop foreign thinking signatures in passthrough — decolua
- Prevent non-SSE stream pipe crash and cross-IdP account overwrites (#2244) — KunN-21
- **Kiro**: route IdC auth to regional CodeWhisperer surface (#2297) — Volodymyr Saakian
- **Kiro**: add Claude Sonnet 5 model support (#2264) — Edison42
- **Xiaomi-tokenplan**: region selector, key validation, multi-connection (#2251) — MiQieR
- **Translator**: strict Anthropic content block compliance (#2225) — Sahrul Ramadhan Hardiansyah
- **Kimchi**: strip reasoning_content echo to bound multi-turn input tokens — KunN-21
- **Kimchi**: bump User-Agent to kimchi/0.1.40 (#2256) — Ansh7473
- **Codebuddy-cn**: strip empty tool_calls arrays to preserve reasoning — zmf
- **Antigravity**: preserve Claude tool delta index (#2223) — Sutarto Jordan Chrisfivo
- **MITM**: generate root CA on server startup (#2228) — Sutarto Jordan Chrisfivo

# v0.5.15 (2026-06-29)

## Features
- Add Kimchi OAuth provider — Nant361
- Refine Qwen vision/video + thinking model patterns — decolua
- Opt-in Codex auto-ping quota keep-alive — Emirhan

## Fixes
- **Responses**: handle response.done terminal events (#2142) — rifuki
- **Headroom**: skip unsafe responses tool history (#2132) — Sutarto Jordan Chrisfivo
- **Translator**: map mid-conversation system message to user (claude→openai) — decolua
- **Gemini**: normalize contents to prevent 400 invalid_argument (#2192) — warelik
- **Gemini**: backfill thoughtSignature + suppress stream done sentinel — WARELIK
- **Alicode**: preserve cache_control for DashScope providers (#2069) — Rex
- **Antigravity**: strip deprecated/readOnly/writeOnly from tool schemas — iletai, Yudhistira-Official
- **CodeBuddy CN**: show bonus packs as one-time, not monthly-replenishing — whale9820
- **Kiro**: strip leaked <thinking> tags from content stream (#2158) — hamsa0x7
- **Tray**: make Windows context menu DPI-aware — Emirhan
- **Kilocode**: expose full gateway catalog in combo model picker — jellylarper
- **OpenCode**: fix Go GLM — decolua

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page — decolua
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source — decolua
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- CodeBuddy CN: show one-shot bonus packs as expiring, not monthly-replenishing
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout — decolua
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian Switchboard tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `SWITCHBOARD_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL
