# Full UI Functional Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an exhaustive, reproducible, read-only browser and compatibility-API audit of every Switchboard dashboard surface against isolated dummy data, then record defects—without fixes—in one deduplicated Markdown ledger.

**Architecture:** One coordinator owns one loopback QA server and one standard-library mock provider. Five workers run in parallel with non-overlapping route/API/control ownership and write temporary JSON result fragments; after the barrier, the coordinator alone deduplicates findings and writes the ledger. Empty/loading/error states use per-browser request interception so the shared database is never reset during parallel work.

**Tech Stack:** Next.js 16, React 19, plain JavaScript ESM, existing SQLite adapter, Node.js standard library, `curl`, and browser automation with accessibility-tree, request-interception, viewport, console, network, and screenshot support. No new dependencies.

**Spec:** User-approved 2026-08-22 full UI functional-audit scope captured in this plan; no separate design document exists.

## Global Constraints

- Work only in `/Users/vijay/IdeaProjects/switchboard/.worktrees/full-ui-audit` on `audit/full-ui-functional`.
- Do not edit application code, test code, configuration, package manifests, lockfiles, migrations, or fixtures.
- Known baseline: 256 files passed, 13 skipped; 2200 tests passed, 13 expected fail, 61 skipped. Do not rerun tests, build, formatter, or linter for this audit.
- Bind only to `127.0.0.1`: Switchboard `22128`, local mock provider `22129`. Never use or stop an existing `20128` instance.
- Use `DATA_DIR=/tmp/switchboard-full-ui-functional-2026-08-22/data`, isolated `HOME`, XDG, AppData, and browser profiles. Never read/write real `~/.switchboard`, real CLI configuration, or the user's browser profile.
- Never use real OAuth tokens, API keys, cookies, sudo passwords, proxy credentials, provider credentials, or personal data. Literal credentials below are dummy local values.
- Never confirm Shutdown, Copy & shutdown, Update, MITM start/stop, DNS/hosts changes, certificate generation/trust, port-443 process termination, Headroom start/stop/proxy, OAuth authorize/exchange/import, Codex reset credits, external catalog install/update, or any host process launch/kill.
- Prohibited controls are still inventoried through their safe boundary: visible/enabled state, accessible name, help text, modal opening, validation, keyboard dismissal, and cancel. Record `NOT EXECUTED — safety gate`; do not treat that as missing coverage.
- Successful model calls target only `http://127.0.0.1:22129/v1`. Built-in provider tests and quota refreshes are never allowed through to the server unless the worker proves they resolve to the mock.
- Every owned route must inventory every live actionable control, form, modal, tab, toggle, dropdown, status/badge, loading/empty/error/success state, keyboard path, and responsive layout.
- Findings only: no fixes, tests, snapshots, suppressions, workarounds, or cleanup.
- Final findings live in exactly one ledger: `docs/qa/2026-08-22-full-ui-functional-audit.md`. Parallel workers never edit it.
- Cited evidence may live under `docs/qa/evidence/2026-08-22-full-ui-functional-audit/`. All seed, logs, mock code, profiles, and worker result JSON stay under `/tmp/switchboard-full-ui-functional-2026-08-22/`.

---

## Files, Interfaces, and Ownership

### Repository artifacts

- Create: `docs/qa/2026-08-22-full-ui-functional-audit.md` — sole findings ledger.
- Create only when cited: `docs/qa/evidence/2026-08-22-full-ui-functional-audit/<finding-id>.<png|json|txt>`.
- Inspect only: source files listed in Tasks 3–7.

### Temporary artifacts

```text
/tmp/switchboard-full-ui-functional-2026-08-22/
├── data/
├── home/
├── browser/{S1-core,S2-providers,S3-routing,S4-tools}/
├── evidence/{S1-core,S2-providers,S3-routing,S4-tools,S5-api}/
├── mock-provider.mjs
├── seed.json
└── results/{readiness,S1-core,S2-providers,S3-routing,S4-tools,S5-api}.json
```

### Non-overlapping parallel ownership

| Owner | Exclusive routes/surfaces | Exclusive API family | Boundary |
|---|---|---|---|
| S1 Core | `/`, `/dashboard`, `/dashboard/endpoint`, `/dashboard/usage?tab=overview|details|logs`; keys and shared badges | `/api/keys*`, `/api/usage/stats|chart|history|logs|request-logs|request-details` | Sole owner of shell/sidebar/header/mobile menu/theme/language/changelog/shutdown-cancel/toasts and shared `Badge`/`CapacityBadges` behavior |
| S2 Providers | `/dashboard/providers`, `/providers/new`, seeded `/providers/[id]`, `/dashboard/quota`, all `/dashboard/media-providers*` | `/api/providers*`, `/api/provider-nodes*`, `/api/models*`, `/api/media-providers*`, `/api/pricing` | Owns provider/model/quota badge accuracy; S1 owns primitive rendering only |
| S3 Routing | `/dashboard/combos`, `/dashboard/combos/routing`, `/dashboard/basic-chat` | `/api/combos*`, `/api/routing*`, basic-chat request | S1 owns shell defects observed here |
| S4 Tools | `/dashboard/cli-tools*`, `/agent-library`, `/token-saver`, `/translator`, `/profile`, `/dashboard/settings/pricing`, `/skills*`, `/console-log`, `/mitm` | `/api/cli-tools*`, `/api/agent-library*`, `/api/token-saver*`, `/api/translator*`, `/api/settings*`, `/api/locale`, `/api/skills*`, `/api/headroom/status` | Settings writes wait for S1/S3; MITM/Headroom/updater/shutdown remain safety-gated |
| S5 API | Compatibility and management API only | `/v1*`, `/v1beta*`, `/responses`, `/codex`, `/api/mgmt/v1*`, `/api/health` | No dashboard interaction and no resource mutation |

If a worker observes an out-of-scope defect, it sends the exact observation/evidence path to the owner and does not file it. A shell defect belongs to S1 regardless of the content route. S5 files only defects reproducible without UI.

## Worker Result Interface

Each worker writes one JSON object to its assigned result path:

```json
{
  "surface": "S1-core",
  "completedRoutes": ["/dashboard"],
  "inventory": [{
    "route": "/dashboard",
    "sourceFiles": ["src/app/(dashboard)/dashboard/OverviewClient.js"],
    "controls": ["Connect Provider link"],
    "forms": [], "modals": [], "tabs": [], "toggles": [], "dropdowns": [],
    "badges": ["endpoint", "learning"],
    "states": ["loading", "empty", "error", "populated"],
    "keyboard": ["Tab", "Shift+Tab", "Enter", "Space", "Escape", "Arrow keys where applicable"],
    "viewports": ["1440x1000", "768x1024", "390x844", "320x568"],
    "result": "pass"
  }],
  "findings": [{
    "severity": "P2",
    "route": "/dashboard/endpoint",
    "control": "Create API Key / Key Name",
    "preconditions": "seeded QA server; S1 browser",
    "steps": ["Open Endpoint & keys", "Open Create Key", "Submit empty name"],
    "expected": "Observable expected contract",
    "actual": "Observed behavior only",
    "evidence": ["/tmp/.../endpoint-empty-name.png"],
    "console": "none", "network": "none",
    "fingerprint": "/dashboard/endpoint|Create API Key|empty-submit|accessible-validation"
  }],
  "safetyGates": ["Shutdown confirm not executed"],
  "notes": []
}
```

A route is complete only when this inventory contains every accessibility-tree control plus any visually actionable element missing from that tree. Workers may report zero findings.

## Severity, Evidence, and Deduplication

- **P0:** credential exposure, real-user state access, destructive host action without confirmation, or paid/external traffic despite containment.
- **P1:** primary flow unusable, data loss, wrong target routed, authentication bypass, inaccessible destructive confirmation, or whole-surface crash.
- **P2:** actionable control/form/state is functionally wrong, misleading, keyboard-inoperable, or causes an unhandled user-affecting error.
- **P3:** reproducible visual, responsive, focus, copy, or accessibility defect; no subjective polish.
- Fingerprint: `<normalized route>|<accessible control name>|<last action>|<stable symptom>`.
- Exact fingerprints merge. Near duplicates merge when one fix addresses them; list all routes/evidence under one finding.
- Final IDs are `QA-001` upward after sort by severity, route, control, fingerprint.
- Evidence for a failure includes a scoped screenshot, accessibility/DOM excerpt, sanitized request/response metadata, and relevant console excerpt. Never capture a key, cookie, Authorization header, real home path, or personal data.

## Common Browser Checklist

For each route:

1. Record URL, HTTP status, title, main heading, console errors/warnings, failed requests, and unhandled page errors.
2. Compare source inventory to live accessibility tree: links, buttons, icon actions, inputs/editors, selects, switches, tabs, expanders, menus, pagination, copy actions, row actions, drag/reorder handles, and external links.
3. Exercise each safe control with pointer and keyboard: visible focus, logical Tab/Shift+Tab order, Enter/Space activation, Escape close, arrow keys where appropriate, modal focus trap, and focus return.
4. Verify form labels, required/disabled/loading boundaries, error association, live status, submit success/failure, cancel, close, backdrop, and reset/restore.
5. Cover loading, empty, error, populated, disabled, and retry/stale states. Synthetic interceptions carry `X-QA-Synthetic-State: 1`; never use them to claim a backend defect.
6. At `1440x1000`, `768x1024`, `390x844`, and `320x568`, verify no page-level horizontal overflow, reachable actions, readable truncation/tooltips, mobile sidebar, responsive stacking, scrollable tables/editors, and viewport-contained modals.
7. Check light/dark on one dense route per worker. S1 files shared theme defects; others file content-specific visibility defects.
8. Compare badge/status text and styling to owned response/seed; never infer “online/connected/ready” from color alone.
9. Restore worker-created records and localStorage. Never reset the shared database while workers run.

---

### Task 1: Coordinator — isolated runtime, mock provider, and deterministic seed

**Files:**
- Create outside repo: `/tmp/switchboard-full-ui-functional-2026-08-22/mock-provider.mjs`
- Create outside repo: `/tmp/switchboard-full-ui-functional-2026-08-22/seed.json`
- Inspect only: `package.json`, `src/app/api/settings/database/route.js`, `src/lib/db/index.js`
- Modify in repo: none

**Interfaces:**
- Produces: `QA_BASE_URL=http://127.0.0.1:22128`, `QA_MOCK_URL=http://127.0.0.1:22129/v1`, `QA_API_KEY=sk-switchboard-qa-only`, seeded DB, and supervisor handles `switchboard-ui-qa` / `switchboard-ui-mock`.
- S1–S5 start only after health, import, containment, and warm-up pass.

- [ ] **Step 1: Capture worktree state without changing it**

```bash
pwd
git branch --show-current
git status --short
git diff --name-only
```

Expected path/branch: the required worktree and `audit/full-ui-functional`. Record pre-existing changes; never clean/reset/stash them.

- [ ] **Step 2: Prepare the isolated environment**

```bash
export QA_ROOT=/tmp/switchboard-full-ui-functional-2026-08-22
export QA_BASE_URL=http://127.0.0.1:22128
export QA_MOCK_URL=http://127.0.0.1:22129/v1
export QA_API_KEY=sk-switchboard-qa-only
export DATA_DIR=$QA_ROOT/data
export HOME=$QA_ROOT/home
export XDG_CONFIG_HOME=$HOME/.config
export XDG_DATA_HOME=$HOME/.local/share
export XDG_CACHE_HOME=$HOME/.cache
export APPDATA=$HOME/AppData/Roaming
export LOCALAPPDATA=$HOME/AppData/Local
export USERPROFILE=$HOME
mkdir -p "$DATA_DIR" "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$APPDATA" "$LOCALAPPDATA" "$QA_ROOT"/{browser,evidence,results}
```

- [ ] **Step 3: Create a standard-library mock provider**

Write `$QA_ROOT/mock-provider.mjs`. It must bind `127.0.0.1:22129` and implement only:

| Method/path | Deterministic response |
|---|---|
| `GET /health` | `200 {"ok":true,"service":"switchboard-qa-mock"}` |
| `GET /v1/models` | OpenAI list; choose `qa-chat`, `qa-response`, `qa-message`, or `qa-embedding` from dummy Authorization/x-api-key value |
| `POST /v1/chat/completions` | OpenAI JSON with text `QA mock reply`; for `stream:true`, two SSE chunks then `[DONE]` |
| `POST /v1/responses` | completed Responses object with `QA mock response` |
| `POST /v1/messages` | Anthropic message with `QA mock message` |
| `POST /v1/embeddings` | one numeric vector `[0.1,0.2,0.3]` |
| all else | `404 {"error":{"message":"QA mock has no METHOD PATH"}}` |

Use only `node:http`; parse JSON with an accumulated UTF-8 body; return 400 for invalid JSON; log `QA_MOCK_READY http://127.0.0.1:22129` after listen. Do not proxy unknown requests.

- [ ] **Step 4: Create exact seed data**

Write `$QA_ROOT/seed.json` using the existing `/api/settings/database` import shape:

```json
{
  "settings": {
    "requireApiKey": true,
    "observabilityEnabled": true,
    "fallbackStrategy": "fill-first",
    "maxRetries": 2,
    "comboStrategy": "fallback",
    "outboundProxyEnabled": false,
    "rtkEnabled": true,
    "headroomEnabled": false,
    "headroomUrl": "http://127.0.0.1:8787",
    "cavemanEnabled": false,
    "cavemanLevel": "full",
    "ponytailEnabled": false,
    "ponytailLevel": "full",
    "tokenSaver": { "vault": true, "vaultThresholdKB": 8 },
    "comboStrategies": {
      "qa-fallback": { "fallbackStrategy": "fallback", "capacityAutoSwitch": true },
      "qa-round-robin": { "fallbackStrategy": "round-robin", "capacityAutoSwitch": false },
      "qa-auto": { "fallbackStrategy": "auto", "routerModel": "qa-openai/qa-chat", "objective": "balanced", "explorationRate": 0.05, "learningEnabled": true, "freezeLearning": false, "feedbackAsk": true, "capacityAutoSwitch": true }
    }
  },
  "providerNodes": [
    { "id": "openai-compatible-chat-qa-local", "type": "openai-compatible", "name": "QA Local Chat", "prefix": "qa-openai", "apiType": "chat", "baseUrl": "http://127.0.0.1:22129/v1" },
    { "id": "openai-compatible-responses-qa-local", "type": "openai-compatible", "name": "QA Local Responses", "prefix": "qa-responses", "apiType": "responses", "baseUrl": "http://127.0.0.1:22129/v1" },
    { "id": "anthropic-compatible-qa-local", "type": "anthropic-compatible", "name": "QA Local Anthropic", "prefix": "qa-anthropic", "baseUrl": "http://127.0.0.1:22129/v1" },
    { "id": "custom-embedding-qa-local", "type": "custom-embedding", "name": "QA Local Embeddings", "prefix": "qa-embed", "baseUrl": "http://127.0.0.1:22129/v1" }
  ],
  "providerConnections": [
    { "id": "qa-chat-success", "provider": "openai-compatible-chat-qa-local", "authType": "apikey", "name": "QA Chat Ready", "priority": 1, "isActive": true, "apiKey": "qa-key-chat", "testStatus": "success", "quotaUsed": 22, "providerSpecificData": { "prefix": "qa-openai", "apiType": "chat", "baseUrl": "http://127.0.0.1:22129/v1", "nodeName": "QA Local Chat", "enabledModels": ["qa-chat"] } },
    { "id": "qa-chat-error", "provider": "openai-compatible-chat-qa-local", "authType": "apikey", "name": "QA Chat Error", "priority": 2, "isActive": true, "apiKey": "qa-key-chat-error", "testStatus": "error", "lastError": "QA synthetic saved error", "errorCode": "QA_ERROR", "quotaUsed": 78, "providerSpecificData": { "prefix": "qa-openai", "apiType": "chat", "baseUrl": "http://127.0.0.1:22129/v1", "nodeName": "QA Local Chat", "enabledModels": ["qa-chat"] } },
    { "id": "qa-chat-disabled", "provider": "openai-compatible-chat-qa-local", "authType": "apikey", "name": "QA Chat Disabled", "priority": 3, "isActive": false, "apiKey": "qa-key-chat-disabled", "testStatus": "unknown", "providerSpecificData": { "prefix": "qa-openai", "apiType": "chat", "baseUrl": "http://127.0.0.1:22129/v1", "nodeName": "QA Local Chat", "enabledModels": ["qa-chat"] } },
    { "id": "qa-responses-success", "provider": "openai-compatible-responses-qa-local", "authType": "apikey", "name": "QA Responses Ready", "priority": 1, "isActive": true, "apiKey": "qa-key-responses", "testStatus": "success", "quotaUsed": 51, "providerSpecificData": { "prefix": "qa-responses", "apiType": "responses", "baseUrl": "http://127.0.0.1:22129/v1", "nodeName": "QA Local Responses", "enabledModels": ["qa-response"] } },
    { "id": "qa-anthropic-success", "provider": "anthropic-compatible-qa-local", "authType": "apikey", "name": "QA Anthropic Ready", "priority": 1, "isActive": true, "apiKey": "qa-key-anthropic", "testStatus": "success", "quotaUsed": 93, "providerSpecificData": { "prefix": "qa-anthropic", "baseUrl": "http://127.0.0.1:22129/v1", "nodeName": "QA Local Anthropic", "enabledModels": ["qa-message"] } },
    { "id": "qa-embedding-success", "provider": "custom-embedding-qa-local", "authType": "apikey", "name": "QA Embeddings Ready", "priority": 1, "isActive": true, "apiKey": "qa-key-embed", "testStatus": "success", "providerSpecificData": { "prefix": "qa-embed", "baseUrl": "http://127.0.0.1:22129/v1", "nodeName": "QA Local Embeddings", "enabledModels": ["qa-embedding"] } }
  ],
  "apiKeys": [
    { "id": "qa-key-active", "key": "sk-switchboard-qa-only", "name": "QA Active Key", "machineId": "qa-machine", "isActive": true, "createdAt": "2026-08-22T00:00:00.000Z" },
    { "id": "qa-key-disabled", "key": "sk-switchboard-qa-disabled", "name": "QA Disabled Key", "machineId": "qa-machine", "isActive": false, "createdAt": "2026-08-22T00:01:00.000Z" }
  ],
  "combos": [
    { "id": "qa-combo-fallback", "name": "qa-fallback", "kind": "llm", "models": ["qa-openai/qa-chat", "qa-anthropic/qa-message"] },
    { "id": "qa-combo-round-robin", "name": "qa-round-robin", "kind": "llm", "models": ["qa-openai/qa-chat", "qa-responses/qa-response"] },
    { "id": "qa-combo-auto", "name": "qa-auto", "kind": "llm", "models": ["qa-openai/qa-chat", "qa-anthropic/qa-message"] }
  ],
  "modelAliases": { "qa-default": "qa-openai/qa-chat" },
  "customModels": [], "mitmAlias": {}, "pricing": {}
}
```

- [ ] **Step 5: Launch via the process supervisor**

Start `switchboard-ui-mock`: `node /tmp/switchboard-full-ui-functional-2026-08-22/mock-provider.mjs`, ready log `QA_MOCK_READY`, port `22129`. Start `switchboard-ui-qa`: `npm run dev -- --hostname 127.0.0.1 --port 22128`, with Step 2 environment, ready log `Ready`, port `22128`, worktree as cwd. Never shell-background or use the product Shutdown API.

- [ ] **Step 6: Verify containment and import/reset procedure**

```bash
curl --fail --silent http://127.0.0.1:22129/health
curl --fail --silent http://127.0.0.1:22128/api/health
curl --fail --silent -H 'Content-Type: application/json' --data-binary @$QA_ROOT/seed.json "$QA_BASE_URL/api/settings/database"
curl --fail --silent "$QA_BASE_URL/api/settings/database" > "$QA_ROOT/export-after-seed.json"
```

Expected import `{"success":true}` and export counts: 6 connections, 4 nodes, 2 keys, 3 combos. This POST is the reset procedure, but it runs only before workers and, if needed, after all workers stop—not during parallel work.

- [ ] **Step 7: Warm usage with local-only calls**

Send one valid request each to `/v1/chat/completions` (`qa-openai/qa-chat`), `/v1/responses` (`qa-responses/qa-response`), and `/v1/messages` (`qa-anthropic/qa-message`) with the dummy key. Expected 200 and only `QA mock` output; `/api/usage/stats?period=24h` reports at least three requests. Any non-loopback attempt is P0 and must be stopped.

- [ ] **Step 8: Publish readiness**

Write `$QA_ROOT/results/readiness.json` with base/mock URLs, seed checksum, environment roots, start time, and supervisor names. Publish `READY`; after this no worker calls `/api/settings/database`.

- [ ] **Step 9: Commit boundary**

No commit; only temporary state.

---

### Task 2: Coordinator — parallel launch and single-writer protocol

**Files:** five temporary result/evidence directories; no repo modifications.

**Interfaces:** Consumes readiness. Produces five complete result fragments. Coordinator is sole integration/ledger owner.

- [ ] Create isolated contexts `S1-core`, `S2-providers`, `S3-routing`, `S4-tools`; S5 uses curl plus a browser observer only when needed for CORS/stream evidence.
- [ ] Give each worker the base URLs, dummy key, exact ownership, result/evidence paths, viewport list, safety gates, and “no repo edits/tests/build/lint/format/server” instruction.
- [ ] Start S1–S5 concurrently after `READY`. S4 defers profile/settings mutations until S1/S3 content passes complete.
- [ ] Allow interception only for owned endpoints, tagged `X-QA-Synthetic-State: 1`; never report backend defects from injected responses.
- [ ] Workers write temporary JSON/evidence only; no ledger edits or commits.
- [ ] **Commit boundary:** none.

---

### Task 3: S1 — overview, endpoint, keys, usage, badges, shell

**Files:**
- Inspect: `src/app/(dashboard)/layout.js`, `src/shared/components/layouts/DashboardLayout.js`, `Sidebar.js`, `Header.js`, `HeaderMenu.js`, `HeaderLanguage.js`, `Badge.js`, `CapacityBadges.js`
- Inspect: `src/app/(dashboard)/dashboard/page.js`, `OverviewClient.js`, `endpoint/**/*.js`, `usage/**/*.js`
- Inspect: `src/shared/components/UsageStats.js`, `RequestLogger.js`
- Write: `$QA_ROOT/results/S1-core.json` only

**Interfaces:** Consumes seeded keys/usage. Creates/deletes exactly one key named `QA S1 Ephemeral`. Produces shell/core inventory/findings.

**Failing audit assertions:** route load/unhandled error; inaccessible/unlabeled control; wrong active navigation; key action targets wrong key; full stored key exposed after reload; state text contradicts response; loading/empty/error has no usable behavior; modal focus escapes/fails to return; page-level overflow.

- [ ] Audit `/` redirect and desktop/mobile shell: every nav/diagnostics link, active state, endpoint pill, breadcrumbs, search/clear where rendered, online/local badges, language menu, grid menu, theme, changelog, mobile sidebar/backdrop/close, toasts. Open/cancel Shutdown with button and Escape; do not confirm. Inventory update banner without activating it.
- [ ] Audit populated `/dashboard`: endpoint URL/status, key/provider counts, Auto/learning badge, combo/routing links, four usage cards, quota bars, all links, both themes, all viewports.
- [ ] Simulate `/api/usage/stats?period=24h` delay 2s, zeros, and 500 `{"error":"QA forced usage error"}` for loading/empty/error. Do not reset DB.
- [ ] Audit `/dashboard/endpoint`: endpoint copy/badges, Require API Key toggle, active/inactive key rows, reveal/copy, toggle, delete confirmation, empty state, Create Key and one-time-key modals, validation/loading/error, cancel/Escape/focus. Create `QA S1 Ephemeral`, verify full key once, reload shows prefix only, toggle/delete only it, preserve seeded keys. Do not screenshot keys.
- [ ] Audit `/dashboard/usage?tab=overview`: Overview/Details control, periods Today/24h/7D/30D/60D, cards, token/cost chart toggle, tooltip/legend, topology, pagination, skeleton/zero/error, URL and browser history.
- [ ] Audit `?tab=details`: provider/date filters, Clear, rows, View Detail, accordion/modal, request/response copy, pagination, empty/invalid-date/loading/500. Audit direct `?tab=logs`: logger stream/status/controls and errors.
- [ ] Audit shared badge accessibility/visual states on owned routes; provider/model/quota semantics remain S2.
- [ ] Remove ephemeral key/interception/localStorage; write result JSON.
- [ ] **Commit boundary:** none.

---

### Task 4: S2 — providers, connections, models, media, quota

**Files:**
- Inspect: `src/app/(dashboard)/dashboard/providers/**/*.js`, `quota/page.js`, `usage/components/ProviderLimits/**/*.js`, `media-providers/**/*.js`
- Inspect: `src/shared/components/EditConnectionModal.js`, `ModelSelectModal.js`
- Write: `$QA_ROOT/results/S2-providers.json` only

**Interfaces:** Consumes four local nodes/six connections; produces provider/model/media/quota inventory. Any created node/connection is named `QA S2 Ephemeral` and removed.

**Failing audit assertions:** counts/status disagree with seed; wrong record toggled/reordered/deleted; local compatible add/edit/test/model flow fails; secret exposed; quota filter/paging/status disagrees with response; any non-loopback provider call.

- [ ] Audit `/dashboard/providers`: search/clear content behavior, OAuth/Free/API-key sections, Test All, Model Availability, Add custom menu and both compatible modals, Show all, cards, status/auth/API-type badges, toggles, no-result, skeleton, test-results modal. Never Test All built-ins.
- [ ] Exercise OpenAI/Anthropic compatible modal validation, cancel/Escape/focus. Create one `QA S2 Ephemeral` OpenAI node at the mock, add/test dummy connection, then delete both.
- [ ] Visit seeded details exactly:
  - `/dashboard/providers/openai-compatible-chat-qa-local`
  - `/dashboard/providers/openai-compatible-responses-qa-local`
  - `/dashboard/providers/anthropic-compatible-qa-local`
  - `/dashboard/providers/custom-embedding-qa-local`
  Inventory back/provider badges, edit node, add single/bulk key, rendered OAuth/import modals, connection reorder/toggle/edit/delete/test/auto-ping/proxy, model refresh/test/verify/filter, add/bulk model, alias/copy/disable/delete, cooldown/error, confirmations, loading/empty/error. Operate only local/ephemeral rows; never submit OAuth/import/cookie/external token flows.
- [ ] Intercept owned provider endpoints for 2s loading, `{"connections":[]}`, 500, detail 404/500; verify UI only.
- [ ] Audit `/dashboard/quota` with all `/api/providers/client*` and `/api/usage/qa-quota-*` requests intercepted. Use two synthetic Codex rows (active/inactive), pagination `{page:1,pageSize:20,total:2,totalPages:1}`, provider options `codex`; active quota is plan `QA Plan` with 5-hour 30/100 and weekly 80/100, reset credits 0. Inventory provider/account/status/sort/expiring filters, disable-depleted/enable-available, auto-refresh/countdown, refresh all/row, copy/edit/toggle/delete, reset-credit view/confirm, table/card paging/page size, loading/empty/401/500, all viewports. Never allow quota calls through, confirm reset, or auto-ping.
- [ ] Audit media routes: hub, `/image`, `/tts`, `/stt`, `/embedding`, `/web`, `/embedding/custom-embedding-qa-local`, and rendered combo/detail links. Inventory modality tabs/cards/badges, custom embedding, connections/models, no-auth cards, example forms, copy/send, voice dropdowns, web controls, combo lifecycle, all states/keyboard/layout. Submit only mock embedding; validate/cancel or intercept image/TTS/STT/web.
- [ ] Remove S2 records/interception/localStorage; verify seed intact; write result JSON.
- [ ] **Commit boundary:** none.

---

### Task 5: S3 — combos, routing, learning, basic chat

**Files:**
- Inspect: `src/app/(dashboard)/dashboard/combos/**/*.js`, `basic-chat/**/*.js`
- Inspect: `src/shared/components/ComboFormModal.js`, `ModelSelectModal.js`
- Inspect: `src/app/api/combos/**/*.js`, `routing/**/*.js`
- Write: `$QA_ROOT/results/S3-routing.json` only

**Interfaces:** Consumes `qa-fallback`, `qa-round-robin`, `qa-auto`, mock models. Creates/deletes `qa-s3-ephemeral` only.

**Failing audit assertions:** wrong combo/model changed; strategy not persisted or card contradicts it; mode switch destroys unrelated fields; query/filter state lost; local learn/version/feedback lacks usable response; basic chat cannot select/send local model; streaming/cancel/grouping broken; state crash.

- [ ] Audit `/dashboard/combos`: Create, empty/help, cards, copy/edit/delete, drag/move/reorder, capacity badges, Insights, Fallback/Round Robin/Fusion/Auto, judge/router pickers, heuristic, objective, learn/freeze/feedback, window/exploration, provider strategy, priority/latency/quota controls, Learn now.
- [ ] Complete `qa-s3-ephemeral` lifecycle: invalid/empty name, zero models, picker, duplicate prevention, add/remove/move, cancel/Escape/focus, submit loading; add `qa-openai/qa-chat` and `qa-anthropic/qa-message`; save/edit/verify/delete. Do not delete seeded combos.
- [ ] For each seeded strategy, compare UI to seed; change/restore one field; verify mode-dependent controls and no unrelated loss.
- [ ] Audit `/dashboard/combos/routing` with no query and `?combo=qa-auto`: back, 7/14/30/90d, cluster/worker, exploration-only, Refresh/Learn, summaries/charts/tooltips/legends/heatmap/model comparison/pick sources/timeline/versions/Promote/Rollback/feedback, loading/no-data/frozen/error. Real seed should honestly show no history.
- [ ] Learn now may run only for `qa-auto` because optimizer is local; verify insufficient-events response. Promote/rollback only QA-created versions and restore. Rich charts/versions use S3 synthetic GET interception.
- [ ] Delay insights 2s, then 500 `{"error":"QA forced routing error"}`, then empty success; verify stale data/retry/filter behavior.
- [ ] Audit `/dashboard/basic-chat`: provider/model loading, search/groups/badges, picker, composer multiline keyboard, send, streaming, stop, transcript, copy/clear/new conversation, states/layout. Select `qa-openai/qa-chat`, send `QA browser chat`, require `QA mock reply` and local-only network. Record the UI's actual request path; if it fails, reproduce it rather than substituting `/v1/chat/completions`.
- [ ] Delete ephemeral combo, restore strategies/interception/localStorage; write result; notify S4 settings may proceed.
- [ ] **Commit boundary:** none.

---

### Task 6: S4 — CLI tools, agent library, token saver, translator, settings, skills, console, MITM

**Files:**
- Inspect: `src/app/(dashboard)/dashboard/cli-tools/**/*.js`, `agent-library/page.js`, `token-saver/TokenSaverClient.js`, `translator/page.js`, `profile/ProfilePageClient.js`, `skills/**/*.js`, `console-log/*.js`, `mitm/*.js`
- Inspect: `src/app/dashboard/settings/pricing/page.js`, `src/shared/constants/cliTools.js`, corresponding API families
- Write: `$QA_ROOT/results/S4-tools.json` only

**Interfaces:** Consumes isolated HOME and waits for S1/S3 before global settings writes. Safe config writes stay under fake HOME and are restored.

**Failing audit assertions:** read/write outside fake HOME/DATA_DIR; missing/unreachable card; Apply/Reset targets wrong fake file; manual config/copy/picker broken; absent state feedback; translator corrupts/sends externally; isolated export/import loses data; prohibited host action; skills mismatch; blocking responsive/keyboard defect.

- [ ] Snapshot/hash fake HOME before tool actions.
- [ ] Audit `/dashboard/cli-tools` cards/status/search/layout, then exact detail IDs: `claude`, `openclaw`, `codex`, `opencode`, `cowork`, `hermes`, `droid`, `cursor`, `cline`, `kilo`, `roo`, `continue`, `qwen`, `deepseek-tui`, `jcode`, `grok`, `pi`, `aider`, `gemini-cli`. For each inventory expand/help, endpoint preset/base/key, primary/subagent/plan/act/model lists, add/remove/reorder, picker/mapping/alias/labels, Apply, Reset/Disconnect, Manual Config, copy, confirmations, badges/live/error/loading/empty, keyboard/layout. Apply/Reset only after proving path under fake HOME.
- [ ] Inventory MITM cards and `/dashboard/mitm`: server/tool badges, selectors/mappings, sudo and port-conflict modals, Start/Stop/trust cert/DNS. Never submit/confirm any mutation; record all safety gates.
- [ ] Audit `/dashboard/agent-library`: enabled, Check/Apply/Doctor, tabs, per-agent skills/MCP, copy/symlink, global/project scope/path, never-overwrite/product skills, manual skill/MCP forms, catalog preview/install, updates preview/confirm/apply, export, badges/states/confirmations/keyboard/layout. Global only to fake HOME; never repository project scope, external install/update, real Doctor, or export outside QA_ROOT.
- [ ] Audit `/dashboard/token-saver`: RTK, Headroom, Caveman/Ponytail levels/toggles, vault/threshold/stats, setup modal/proxy/copy/refresh/close and states. Settings-only toggles may be restored after S1/S3; never Headroom start/stop/proxy.
- [ ] Audit `/dashboard/translator`: four step expanders/editors, Load/Format/Copy/→OpenAI/→Target/Send, malformed/empty JSON, loading/error, editor keyboard/copy/collapse/mobile. Send only if model/target is `qa-openai/qa-chat` and outbound is mock; otherwise validate/cancel.
- [ ] After S1/S3, audit `/dashboard/profile`: light/dark/system, language, DB Export/Import, provider/combo strategy, numeric bounds, outbound proxy URL/no-proxy/Test/Apply, observability, machine ID/copy, shutdown modal, states/keyboard/layout. Export under QA_ROOT; import only unchanged isolated export after all workers. Open/cancel Shutdown. Audit `/dashboard/settings/pricing` provider/model price validation/save/reset/states using QA data.
- [ ] Audit `/dashboard/skills`, `/skills/switchboard`, `/skills/switchboard-chat`, `/api/skills/switchboard`, `/api/skills/switchboard-chat`: copy/open/new-tab, badges, raw/readable content, 404/error, keyboard/layout. Audit `/dashboard/console-log` stream/status/scroll/clear/copy/filter/reconnect/error. MITM remains read-only.
- [ ] Synthetic representative delays/500s: `/api/cli-tools/all-statuses`, `/api/agent-library`, `/api/token-saver/vault-stats`, `/api/translator/load`, `/api/settings`, `/api/skills/switchboard`.
- [ ] Restore fake HOME from manifest and isolated settings export only after all workers finish; clear interception/localStorage; write result with every safety-gated control.
- [ ] **Commit boundary:** none.

---

### Task 7: S5 — compatibility and management API smoke

**Files:**
- Inspect: `next.config.mjs`, `src/app/api/v1/**/*.js`, `v1beta/**/*.js`, `mgmt/v1/**/*.js`, `src/dashboardGuard.js`
- Write: `$QA_ROOT/results/S5-api.json` only

**Interfaces:** Consumes dummy key/local models. Produces request/status/schema/CORS/stream/security inventory. No resource mutations.

**Failing audit assertions:** rewrite/status wrong; local chat/responses/messages/embeddings fail; auth contract broken; malformed stream/CORS; wrong management envelope; secret exposure; validation reaches upstream; unusable error.

- [ ] For every request record masked method/URL/headers, status, content type, duration, response keys, CORS, and mock observation.
- [ ] Health/models: `GET /api/health`, `/v1/models`, `/v1/models/llm`, `/v1/models/info`, `/api/v1/models`; require list contains `qa-openai/qa-chat`, `qa-responses/qa-response`, `qa-anthropic/qa-message`. Test OPTIONS for chat, messages, Gemini.
- [ ] Chat: POST `/v1/chat/completions` nonstream and stream; expect OpenAI shape, `QA mock reply`, usage, valid SSE and `[DONE]`. Repeat `/v1/v1/chat/completions` rewrite.
- [ ] Responses: POST `/v1/responses`, `/responses`, `/codex` with `qa-responses/qa-response`; expect completed output `QA mock response`. Test `/v1/responses/compact` minimally or its pre-upstream validation contract.
- [ ] Anthropic: POST `/v1/messages` with local model/version/key; expect `QA mock message`. POST `/v1/messages/count_tokens` with text/tool blocks; expect positive integer; invalid JSON -> 400.
- [ ] Gemini/Ollama: POST `/v1beta/models/qa-openai/qa-chat:generateContent` and `:streamGenerateContent?alt=sse`; verify Gemini JSON/SSE. POST `/v1/api/chat`; verify Ollama transform.
- [ ] Embeddings: POST `/v1/embeddings` with `qa-embed/qa-embedding`; expect numeric vector. For images, audio speech/transcription, search, web fetch, send deliberately missing-required-field requests that fail 4xx before provider choice; verify mock sees none.
- [ ] Auth negatives: representative chat with missing key, malformed bearer, disabled `sk-switchboard-qa-disabled`, wrong key, valid key. Record actual local-loopback exemption if intentional; never change settings/keys.
- [ ] Management GET only: `/api/mgmt/v1/health`, `/version`, `/providers`, `/combos`, `/usage`, `/routing`; expect 200, `{v:1,data}`, no-store, seeded counts, and no full credential/key/token/cookie. No management mutations.
- [ ] Read usage stats/details after matrix; verify count increases and no Authorization/x-api-key exposure; send UI observations to S1.
- [ ] Write result with per-request inventory and proof every successful upstream terminated at `127.0.0.1:22129`.
- [ ] **Commit boundary:** none.

---

### Task 8: Coordinator — deduplicate, ledger, integrity, shutdown

**Files:**
- Create: `docs/qa/2026-08-22-full-ui-functional-audit.md`
- Create only cited evidence: `docs/qa/evidence/2026-08-22-full-ui-functional-audit/*`
- Read: five temporary results/readiness
- Modify application/test files: none

**Interfaces:** Consumes five complete fragments. Produces sole deduplicated ledger, cited sanitized evidence, and documentation-only diff.

- [ ] Validate every result parses and covers all assigned routes/API cases, inventory categories, four viewports, keyboard/a11y, states, safety gates, and restored state. Return gaps to owner; do not infer.
- [ ] Normalize/merge fingerprints, enforce owner rules, sort P0→P3 then route/control/fingerprint, assign `QA-001` upward.
- [ ] Copy only cited evidence to final evidence directory after inspecting for credentials, personal data, real-home paths, unrelated content; replace unsafe screenshots with sanitized text excerpts.
- [ ] Write the ledger with exact sections:

```markdown
# Full UI Functional Audit — 2026-08-22

## Run metadata
- Branch/worktree, QA/mock URLs, isolation roots, seed checksum
- Browser/runtime versions, timestamps, known test baseline (not rerun)
- Explicit safety exclusions

## Coverage summary
| Surface | Routes/API cases | Controls inventoried | Viewports | Keyboard/a11y | Loading/empty/error | Result |

## Findings summary
| ID | Severity | Route | Control/state | Short symptom | Evidence |

## Findings
### QA-001 — <concise title>
- **Severity:** P0/P1/P2/P3
- **Owner/surface:** S1/S2/S3/S4/S5
- **Exact route/control:** exact URL and accessible name/state
- **Preconditions:** seed/interception/viewport/theme
- **Reproduction:** numbered exact steps
- **Expected:** observable contract
- **Actual:** observed behavior only
- **Evidence:** relative links
- **Console/network:** exact status/error or `none`
- **Fingerprint:** normalized value
- **Source changes/fix:** none; not attempted

## Passed coverage
- Route-by-route controls/states that passed

## Safety-gated controls
- Prohibited control, safe boundary reached, why confirm was not executed

## Uncovered/blocked cases
- Exact attempts and blockers only

## Repository integrity
- Pre/post status comparison and allowed documentation paths
```

If zero defects, say “No reproducible defects found” but keep full passed coverage and safety gates.

- [ ] Acceptance check: all dashboard/dynamic routes; every control/form/modal/tab/toggle/dropdown/badge; loading/empty/error/populated; keyboard/a11y; four layouts; API smoke; one QA server; isolated data; no real credentials/spend/host/MITM/shutdown/updater; exact reproduction/expected/actual/evidence; no duplicates; no fixes.
- [ ] Verify documentation-only repository state:

```bash
git status --short
git diff --name-only
git diff --check
```

Allowed audit-created paths only:

```text
docs/superpowers/plans/2026-08-22-full-ui-functional-audit.md
docs/qa/2026-08-22-full-ui-functional-audit.md
docs/qa/evidence/2026-08-22-full-ui-functional-audit/*
```

Preserve and attribute pre-existing changes.

- [ ] Stop `switchboard-ui-qa` and `switchboard-ui-mock` through the process supervisor. Verify ports close. Never call Shutdown APIs or kill an unverified PID.
- [ ] Final commit boundary: one documentation-only commit after audit:

```bash
git add docs/superpowers/plans/2026-08-22-full-ui-functional-audit.md docs/qa/2026-08-22-full-ui-functional-audit.md docs/qa/evidence/2026-08-22-full-ui-functional-audit
git commit -m "test(qa): record full UI functional audit"
```

Omit the evidence path if no cited evidence exists. No application/test files or temporary artifacts. Bug fixes require separate approval and commits after ledger review.
