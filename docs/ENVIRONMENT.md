# Environment variables

_Last verified against runtime reads: 2026-07-11_

Switchboard stores normal product configuration in SQLite. Environment
variables are for process startup, operator-enforced security, deployment
plumbing, diagnostics, and a small number of provider fallbacks.

## Precedence

- `REQUIRE_API_KEY` explicitly overrides the persisted `requireApiKey` setting.
- Observability values stored in SQLite take precedence when present; their
  environment counterparts supply deployment defaults. `OBSERVABILITY_MAX_BUFFER`
  remains a process-only safety cap.
- Dashboard-managed outbound proxy settings are copied into the standard proxy
  variables at runtime. If the dashboard proxy is disabled, externally supplied
  proxy variables are left untouched.
- Provider connection credentials stored in SQLite take precedence over the
  provider fallback variables listed below.
- Variables described as internal are set by Switchboard itself and should not
  normally be configured by users.

## Runtime, storage, and security

| Variable | Default | Purpose |
|---|---:|---|
| `DATA_DIR` | platform data directory | Root for SQLite, backups, runtime metadata, generated secrets and MITM state. |
| `PORT` | `20128` in launcher scripts | HTTP listen port. |
| `HOSTNAME` | `127.0.0.1` in supported launchers | Bind address. Use `0.0.0.0` only with `start:standalone` and an intentional network policy. |
| `NODE_ENV` | set by the launcher | Next.js runtime mode. |
| `REQUIRE_API_KEY` | persisted setting, then `true` | Operator override for the non-loopback `/v1` API-key gate. Accepts `true/false`, `1/0`, or `yes/no`. |
| `API_KEY_SECRET` | generated per installation | HMAC secret for Switchboard API-key structure. Existing installations should keep it stable. |
| `MACHINE_ID_SALT` | generated per installation | Salt for the stable, privacy-preserving machine identifier. |
| `SHUTDOWN_SECRET` | unset | Development-only bearer secret for `/api/shutdown`; the route is disabled in production. |
| `KEEP_ALIVE_TIMEOUT` | Next standalone default | HTTP keep-alive timeout used by the generated standalone server. |

`API_KEY_SECRET` and `MACHINE_ID_SALT` are optional because Switchboard creates
mode-`0600` values under `${DATA_DIR}/auth`. Set them explicitly only when a
deployment must reproduce the same identity across rebuilt storage.

## Network and proxy

| Variable | Default | Purpose |
|---|---:|---|
| `HTTP_PROXY`, `http_proxy` | unset | Proxy for HTTP upstreams. |
| `HTTPS_PROXY`, `https_proxy` | unset | Proxy for HTTPS upstreams. |
| `ALL_PROXY`, `all_proxy` | unset | Fallback proxy, including supported SOCKS schemes. |
| `NO_PROXY`, `no_proxy` | unset | Hosts that bypass the upstream proxy. |
| `SWITCHBOARD_LOCAL_PEERS` | loopback only | Comma-separated trusted socket peers/CIDRs for dashboard local-request checks. Compose sets only its gateway address. |
| `SWITCHBOARD_PROXY_CLIENT_MAX_BODY_SIZE` | `128mb` | Next.js proxy request-body ceiling. |
| `SWITCHBOARD_TRUST_REAL_IP` | unset | Internal flag set by `custom-server.js` after it derives the peer from the TCP socket. Do not set behind the ordinary Next server. |
| `SWITCHBOARD_PROXY_MANAGED` | unset | Internal marker indicating that dashboard proxy settings populated process environment. |
| `SWITCHBOARD_PROXY_URL` | unset | Internal normalized dashboard-managed proxy URL. |
| `SWITCHBOARD_NO_PROXY` | unset | Internal normalized dashboard-managed bypass list. |

## Request, stream, and retry limits

All values are positive integer milliseconds unless stated otherwise.

| Variable | Default | Purpose |
|---|---:|---|
| `STREAM_FIRST_CHUNK_TIMEOUT_MS` | `200000` | Maximum wait for the first upstream response chunk. |
| `STREAM_STALL_TIMEOUT_MS` | `360000` | Maximum silence after streaming has started. |
| `FETCH_CONNECT_TIMEOUT_MS` | `60000` | General upstream wait for response headers. |
| `GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS` | `45000` | Gemini native TTS response-header timeout. |
| `USAGE_HISTORY_MAX` | `50000` | Maximum retained usage-history rows during cleanup. |

The MITM bypass transport also has a fixed ten-second connection timeout so a
broken local interception path cannot hang indefinitely.

## Logging and observability

| Variable | Default | Purpose |
|---|---:|---|
| `LOG_LEVEL` | `INFO` | Application logger threshold. |
| `ENABLE_REQUEST_LOGS` | `false` | Enables detailed request/translation logs. Logs may contain sensitive prompts. |
| `ENABLE_TRANSLATOR` | `false` | Exposes translator tooling status in the settings response. |
| `OBSERVABILITY_ENABLED` | `true` | Default for request-detail capture when SQLite has no explicit setting. |
| `OBSERVABILITY_MAX_RECORDS` | `200` repository fallback | Default retained request-detail rows; the normal SQLite default is `1000`. |
| `OBSERVABILITY_BATCH_SIZE` | `20` | Rows per request-detail flush. |
| `OBSERVABILITY_FLUSH_INTERVAL_MS` | `5000` | Maximum delay before a partial buffer flush. |
| `OBSERVABILITY_MAX_JSON_SIZE` | `5` | Maximum size of each stored JSON field in KiB. |
| `OBSERVABILITY_MAX_BUFFER` | `5000` | Hard cap on unflushed in-memory request-detail rows. |
| `CURSOR_STREAM_DEBUG` | unset | Set to `1` for Cursor executor stream diagnostics. |
| `CURSOR_PROTOBUF_DEBUG` | unset | Set to `1` for Cursor protobuf diagnostics. |
| `DEBUG_MITM` | unset | Enables verbose MITM request diagnostics. |

## Provider and tool fallbacks

These do not replace normal dashboard connections. They support compatible
nodes, scripts, or provider-specific fallback paths.

| Variable | Default | Purpose |
|---|---:|---|
| `OPENAI_API_KEY` | unset | Fallback API key used by the Azure/OpenAI-compatible executor path. |
| `AZURE_ENDPOINT` | connection/registry value | Azure OpenAI endpoint fallback. |
| `AZURE_DEPLOYMENT` | connection/registry value | Azure deployment fallback. |
| `AZURE_API_VERSION` | connection/registry value | Azure API-version fallback. |
| `AZURE_ORGANIZATION` | unset | Optional OpenAI organization header on the Azure-compatible path. |
| `KIMI_CODING_OAUTH_CLIENT_ID` | registry value | Override for the Kimi Coding OAuth client id. |
| `HEADROOM_URL` | `http://localhost:8787` | Default Headroom service URL before a SQLite setting is saved. |
| `MITM_ROUTER_BASE` | `http://localhost:20128` | Local gateway base used by the standalone MITM helper. |
| `ROUTER_API_KEY` | unset | API key forwarded by the standalone MITM helper. |
| `MITM_SERVER_PATH` | auto-detected | Override path to the bundled MITM server entry point. |

The following variables are used only by repository utilities, not by the
running gateway: `GLM_API_ENDPOINT`, `GLM_API_KEY`, `GLM_API_MODEL`,
`GLM_MAX_TOKENS`, `GLM_TEMPERATURE`, `TRANSLATE_BATCH_SIZE`, plus `BASE_URL`,
`API_KEY`, `COMBO`, and `MEMBERS` in the combo smoke-test script.

## CLI, updater, and packaging internals

These variables are launcher implementation details. Override them only while
developing or packaging the CLI.

| Variable | Default | Purpose |
|---|---:|---|
| `TRAY_MODE` | unset | Internal marker for a tray-launched process. |
| `SWITCHBOARD_NPM_PACKAGE` | `switchboard-router` | Package queried by version/update flows. |
| `NPM_UPDATE_PACKAGE` | package default | Backward-compatible package-name override. |
| `UPDATER_SCRIPT_PATH` | auto-detected | Updater entry-point override. |
| `UPDATER_PKG_NAME` | `switchboard-router` | Package installed by the detached updater. |
| `UPDATER_PORT` | `20129` | Updater status port. |
| `UPDATER_APP_PORT` | `20128` | Application port checked during restart. |
| `UPDATER_TAIL_LINES` | `8` | Installer-output lines included in status. |
| `UPDATER_RETRIES` | `3` | Relaunch health-check attempts. |
| `UPDATER_RETRY_DELAY_MS` | `5000` | Delay between relaunch attempts. |
| `UPDATER_LINGER_MS` | `30000` | Time updater status remains available after completion. |
| `UPDATER_WAIT_MIN_MS` | `3000` | Minimum wait for the parent process to stop. |
| `UPDATER_WAIT_MAX_MS` | `15000` | Maximum wait for the parent process to stop. |
| `UPDATER_WAIT_CHECK_MS` | `500` | Parent-process polling interval. |
| `UPDATER_RELAUNCH` | unset | Internal `1` marker enabling relaunch. |
| `UPDATER_RELAUNCH_CMD` | unset | Internal executable to relaunch. |
| `UPDATER_RELAUNCH_ARGS` | `[]` | Internal JSON argument array for relaunch. |

## Build and platform variables

| Variable | Default | Purpose |
|---|---:|---|
| `NEXT_DIST_DIR` | `.next` | Alternate Next.js build directory used by CLI packaging. |
| `NEXT_TRACING_ROOT_MODE` | repository root | Set to `workspace` when output tracing must include the parent workspace. |
| `NEXT_PHASE` | set by Next.js | Detects build/export phases so builds never open the operator database. |
| `APPDATA`, `LOCALAPPDATA`, `HOME`, `XDG_CONFIG_HOME`, `PATH`, `DISPLAY`, `SystemRoot` | platform-provided | OS paths and desktop/tool discovery. |
| `CODESPACES`, `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN` | platform-provided | GitHub Codespaces launch behavior. |

`NEXT_PUBLIC_CLOUD_URL` is retained only by compatibility UI code for older CLI
configuration. Switchboard no longer implements cloud sync. `NEXT_PUBLIC_BASE_URL`
and `BASE_URL` are not required by the application runtime.
