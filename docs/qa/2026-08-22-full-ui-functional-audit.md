# Full UI Functional Audit — 2026-08-22

## Run metadata

- **Branch:** `audit/full-ui-functional` in the dedicated `full-ui-audit` worktree.
- **Audit window:** isolated services started at `2026-08-22T00:51:28Z`; readiness published at `2026-08-22T00:55:31Z`. Fragment completion timestamps were not recorded.
- **Gateway:** `http://127.0.0.1:22128`; supervisor `switchboard-ui-qa`; loopback-only bind.
- **Mock provider:** `http://127.0.0.1:22129/v1`; supervisor `switchboard-ui-mock`; standard-library `node:http` mock with deterministic chat, Responses, Messages, model, and embedding responses. Unknown paths returned local 404 responses rather than proxying.
- **Isolation roots:** temporary QA data, HOME, XDG, AppData, and browser profiles under `<QA_ROOT>`; no real user configuration path is recorded in this ledger or its evidence.
- **Seed:** SHA-256 `673c43822fe81ea48be14dff40ff57314af2598293bb6023aa3a860674eb4bad`; 6 provider connections, 4 provider nodes, 2 API keys, and 3 combos. Credential values are omitted.
- **Warm-up/containment:** local chat, Responses, and Messages calls each returned the expected QA mock marker; initial 24-hour usage count was 7. All configured provider base URLs were loopback, outbound proxying was disabled, no external provider request was observed, and no real credential was used.
- **Browser/runtime:** ego-browser driving Chromium against the Next.js 16 / React 19 development server. Exact Chromium and Node.js version strings were not captured by the worker fragments and are recorded as a coverage limitation rather than inferred.
- **Known baseline:** 256 files passed, 13 skipped; 2,200 tests passed, 13 expected failures, 61 skipped. This baseline was supplied by the plan and was **not rerun**. No test, build, lint, format, or project validation command was run for this audit.
- **Safety exclusions:** no destructive host action, real shutdown/update, external provider traffic, OAuth exchange/import, management mutation, or real-user-state access was executed.

## Fragment and deduplication integrity

- All five JSON fragments parsed and conformed to the required top-level, inventory, and finding schemas.
- Raw findings: **35** (`P0: 0`, `P1: 4`, `P2: 22`, `P3: 9`). Exact fingerprint duplicates: **0**. Final findings: **35** with the same severity totals.
- The source workers had already merged same-fix observations within a surface (for example, the S1 core overlay finding, S2 provider-dialog finding, and S4 settings-control finding). Similar symptoms across different owning components were retained separately because the evidence did not establish that one source change would resolve them.
- Final ordering is severity `P0`→`P3`, then route, control, and fingerprint. IDs were assigned only after that ordering.

## Coverage summary

| Surface | Completed routes/API cases | Inventory records | Listed controls/forms/modals/tabs/toggles/dropdowns/badges | Viewports | Keyboard/a11y | Loading/empty/error coverage | Result |
|---|---:|---:|---|---|---|---|---|
| S1-core | 6 | 6 | 81/4/8/5/7/5/14 | 1440×1000, 768×1024, 390×844, 320×568 | 5/6 inventories | 6/6 inventories | fail 5; pass 1 |
| S2-providers | 16 | 8 | 63/21/15/8/9/10/32 | 1440×1000, 768×1024, 390×844, 320×568 | 7/8 inventories | 8/8 inventories | fail 1; pass 1; pass-with-findings 6 |
| S3-routing | 4 | 4 | 26/4/6/0/7/11/17 | 1440×1000, 768×1024, 390×844, 320×568 | 4/4 inventories | 4/4 inventories | fail 2; pass 2 |
| S4-tools | 32 | 32 | 221/73/65/12/13/67/86 | Required four attempted; exact sweep limited | 30/32 inventories | 32/32 inventoried; dynamic gaps below | fail 5; limited 7; pass 20 |
| S5-api | 30 | 19 | 30/0/0/0/0/0/0 | API-only | N/A: API-only | 19/19 API inventories | fail 8; pass 11 |

Counts are fragment inventory entries, not deduplicated DOM-node counts; entries such as “19 CLI tool card links” intentionally represent multiple live controls. Column order is controls/forms/modals/tabs/toggles/dropdowns/badges.

## Findings summary

| ID | Severity | Route | Control/state | Short symptom | Evidence |
|---|---|---|---|---|---|
| QA-001 | P1 | /dashboard/basic-chat | Send / local qa-chat | Basic Chat posts to a nonexistent endpoint | [S3-routing bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) |
| QA-002 | P1 | /dashboard/mitm | Start Server / Sudo Password Required confirmation | MITM sudo confirmation is inaccessible | [S4-tools bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) |
| QA-003 | P1 | /dashboard/profile | Shutdown / confirmation | Shutdown confirmation lacks dialog focus | [S4-tools bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) |
| QA-004 | P1 | /v1/api/chat | Ollama-compatible POST /api/chat transform | Ollama transform drops assistant content | [S5-api bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) |
| QA-005 | P2 | /api/mgmt/v1/health | Unauthorized management response cache policy | Unauthorized management responses are cacheable | [S5-api bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) |
| QA-006 | P2 | /dashboard | Menu > Theme | Light theme selection leaves the UI dark | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-007 | P2 | /dashboard/basic-chat | New conversation | Basic Chat cannot start a same-model conversation | [S3-routing bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) |
| QA-008 | P2 | /dashboard/basic-chat | Stop | Stopping generation leaves a blank assistant turn | [S3-routing bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) |
| QA-009 | P2 | /dashboard/combos | Create Combo modal | Create Combo modal leaks keyboard focus | [S3-routing bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) |
| QA-010 | P2 | /dashboard/combos | Model row value / Click to edit | Combo model ID editing is pointer-only | [S3-routing bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) |
| QA-011 | P2 | /dashboard/console-log | Console stream / disconnected state | Console disconnection is rendered as an empty stream | [S4-tools bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) |
| QA-012 | P2 | /dashboard/endpoint | Create API Key / shared Modal and confirmation surfaces | Core overlays lack dialog focus management | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-013 | P2 | /dashboard/media-providers/embedding/custom-embedding-qa-local | Example / Run | Masked media key prevents embedding requests | [S2-providers bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) |
| QA-014 | P2 | /dashboard/mitm | Antigravity / GitHub Copilot / Kiro card expanders | MITM tool disclosures are keyboard unreachable | [S4-tools bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) |
| QA-015 | P2 | /dashboard/settings/pricing | Edit Pricing / Pricing Configuration | Pricing editor lacks modal keyboard behavior | [S4-tools bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) |
| QA-016 | P2 | /dashboard/translator | Client Request / Format | Translator Format silently ignores malformed JSON | [S4-tools bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) |
| QA-017 | P2 | /dashboard/translator | Target Request / Send | Translator Send silently accepts an empty request | [S4-tools bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) |
| QA-018 | P2 | /dashboard/usage?tab=details | Request details results | Request-details errors look like empty results | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-019 | P2 | /dashboard/usage?tab=details | Start Date / End Date | Inverted usage date ranges are accepted | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-020 | P2 | /dashboard/usage?tab=logs | Auto Refresh (3s) | Log auto-refresh is pointer-only | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-021 | P2 | /dashboard/usage?tab=overview | 24h period / usage statistics | Failed usage periods display stale data as current | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-022 | P2 | /dashboard/usage?tab=overview | Sortable usage table headers and expandable group rows | Usage table actions are keyboard unreachable | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-023 | P2 | /v1/chat/completions; /v1/messages; /v1beta/models/:model:generateContent | Cross-origin browser request / CORS preflight | Compatibility APIs fail browser CORS preflight | [S5-api bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) |
| QA-024 | P2 | /v1/models/info?id=qa-openai/qa-chat | GET model metadata for advertised model | Advertised model metadata returns not found | [S5-api bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) |
| QA-025 | P2 | /v1/models/llm | GET LLM-filtered model discovery | LLM model discovery rejects the llm kind | [S5-api bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) |
| QA-026 | P2 | /v1beta/models | Gemini-compatible active model discovery | Gemini discovery omits an active local model | [S5-api bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) |
| QA-027 | P3 | /dashboard | Mobile navigation drawer | Mobile navigation cannot be dismissed accessibly | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-028 | P3 | /dashboard/basic-chat | Attach / Send / Stop icon buttons | Basic Chat icon actions expose glyph names | [S3-routing bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) |
| QA-029 | P3 | /dashboard/endpoint | Key row icon actions and shared header/pagination icon actions | Core icon actions lack purposeful names | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |
| QA-030 | P3 | /dashboard/media-providers/{kind}/{id} | Media Example form fields | Media example fields lack programmatic labels | [S2-providers bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) |
| QA-031 | P3 | /dashboard/profile; /dashboard/token-saver; /dashboard/agent-library; /dashboard/settings/pricing | Switches, enablement checkboxes, and pricing numeric fields | Settings form controls lack accessible names | [S4-tools bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) |
| QA-032 | P3 | /dashboard/providers (+ provider detail, quota, and media modal routes) | Provider, connection, quota, and custom-embedding modal dialogs | Provider modals lack dialog semantics | [S2-providers bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) |
| QA-033 | P3 | /dashboard/providers/new | Provider, Authentication Method, API Key, and Display Name fields | New-provider labels and errors are unassociated | [S2-providers bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) |
| QA-034 | P3 | /dashboard/providers/openai-compatible-chat-qa-local | Connection reorder and model test/copy icon buttons | Provider icon actions expose glyph names | [S2-providers bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) |
| QA-035 | P3 | /dashboard/usage | Overview/Details, periods, pagination and request collapsibles | Usage controls hide selected and expanded state | [S1-core bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) |

## Findings

### QA-001 — Basic Chat posts to a nonexistent endpoint

- **Severity:** P1
- **Owner/surface:** S3-routing
- **Exact route/control:** `/dashboard/basic-chat` — Send / local qa-chat
- **Preconditions:** seeded QA server; S3 isolated browser; QA Local Chat selected; only loopback mock configured
- **Reproduction:**
  1. Open Basic Chat and wait for connected model groups
  2. Select the seeded QA Chat Ready qa-chat model
  3. Enter QA browser chat and press Enter
  4. Observe the actual UI request path and assistant state
  5. Reproduce the same request path with seeded qa-openai/qa-chat
- **Expected:** The UI posts to an implemented local chat endpoint, streams QA mock reply, and the request terminates at 127.0.0.1:22129.
- **Actual:** The UI posts to /api/dashboard/chat/completions, which is not implemented and returns 404 text/html. The conversation renders Error: Failed to fetch and the mock is never reached. The UI-selected request model is also the internal id openai-compatible-chat-qa-local/qa-chat rather than the seeded qa-openai/qa-chat alias.
- **Sanitized evidence:** [S3-routing evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) — `basic-chat-404.json`
- **Console/network:** console: none; the failure is rendered in the transcript; network: POST /api/dashboard/chat/completions -> 404 text/html; no 127.0.0.1:22129 request observed
- **Fingerprint:** `/dashboard/basic-chat|Send|submit-local-message|nonexistent-chat-endpoint-404`
- **Source fragment fingerprint:** `/dashboard/basic-chat|Send|submit-local-message|nonexistent-chat-endpoint-404` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-002 — MITM sudo confirmation is inaccessible

- **Severity:** P1
- **Owner/surface:** S4-tools
- **Exact route/control:** `/dashboard/mitm` — Start Server / Sudo Password Required confirmation
- **Preconditions:** seeded QA server; S4 browser; real local status GET completed; MITM stopped
- **Reproduction:**
  1. Open MITM
  2. Wait for Start Server to enable
  3. Activate Start Server
  4. Inspect focus and dialog semantics
  5. Press Escape
  6. Cancel without confirming
- **Expected:** A destructive host-action confirmation is announced as a modal dialog, traps/moves focus, and supports keyboard dismissal/cancel.
- **Actual:** The sudo prompt has no role=dialog, focus remains on the background Start Server trigger, and Escape does not dismiss it; Cancel works. No mutation was confirmed.
- **Sanitized evidence:** [S4-tools evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) — `observations.txt`
- **Console/network:** console: none; network: GET status only; no POST/PATCH/DELETE
- **Fingerprint:** `/dashboard/mitm|Start Server / Sudo Password Required|open-confirmation|inaccessible-destructive-dialog`
- **Source fragment fingerprint:** `/dashboard/mitm|Start Server / Sudo Password Required|open-confirmation|inaccessible-destructive-dialog` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/mitm/MitmPageClient.js`, `src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-003 — Shutdown confirmation lacks dialog focus

- **Severity:** P1
- **Owner/surface:** S4-tools
- **Exact route/control:** `/dashboard/profile` — Shutdown / confirmation
- **Preconditions:** seeded QA server; S1/S3 settings restored; S4 browser
- **Reproduction:**
  1. Open Settings
  2. Scroll Shutdown into view
  3. Activate Shutdown
  4. Inspect dialog semantics and focus
  5. Press Escape
- **Expected:** Shutdown confirmation is a labelled modal dialog and focus moves into it before any destructive confirmation is possible.
- **Actual:** Confirmation has no role=dialog and focus remains on the background Shutdown trigger. Escape dismisses it. Shutdown was not confirmed.
- **Sanitized evidence:** [S4-tools evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) — `observations.txt`
- **Console/network:** console: none; network: none; shutdown endpoint not called
- **Fingerprint:** `/dashboard/profile|Shutdown|open-confirmation|inaccessible-destructive-dialog`
- **Source fragment fingerprint:** `/dashboard/profile|Shutdown|open-confirmation|inaccessible-destructive-dialog` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/profile/ProfilePageClient.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-004 — Ollama transform drops assistant content

- **Severity:** P1
- **Owner/surface:** S5-api
- **Exact route/control:** `/v1/api/chat` — Ollama-compatible POST /api/chat transform
- **Preconditions:** seeded QA server; qa-openai/qa-chat; stream:false; loopback-only mock
- **Reproduction:**
  1. POST /v1/api/chat with model qa-openai/qa-chat, one user message, and stream:false
  2. Read the 200 application/x-ndjson response
  3. Inspect message.content
- **Expected:** Ollama response preserves the upstream assistant text `QA mock reply`.
- **Actual:** Response is 200/done:true but message.content is an empty string, discarding the model reply.
- **Sanitized evidence:** [S5-api evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) — `requests-sanitized.json`, `assertions.json`
- **Console/network:** console: none; network: POST /v1/api/chat -> 200 application/x-ndjson; message.content=""
- **Fingerprint:** `/v1/api/chat|Ollama response message.content|POST stream:false|assistant-content-empty`
- **Source fragment fingerprint:** `/v1/api/chat|Ollama response message.content|POST stream:false|assistant-content-empty` (not merged across fragments)
- **Likely owning area:** `src/app/api/v1/api/chat/route.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-005 — Unauthorized management responses are cacheable

- **Severity:** P2
- **Owner/surface:** S5-api
- **Exact route/control:** `/api/mgmt/v1/health` — Unauthorized management response cache policy
- **Preconditions:** loopback TCP request forced through non-local auth branch using non-loopback Origin; no management token
- **Reproduction:**
  1. GET /api/mgmt/v1/health with Origin http://qa-nonlocal.invalid and no credentials
  2. Repeat with the ordinary gateway key, which is not a management token
  3. Inspect response envelope and Cache-Control header
- **Expected:** 401 {v:1,error} management responses also carry Cache-Control: no-store, matching management success/error contracts.
- **Actual:** Both responses correctly return 401 {v:1,error}, but Cache-Control is absent.
- **Sanitized evidence:** [S5-api evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) — `requests-sanitized.json`, `assertions.json`
- **Console/network:** console: none; network: GET /api/mgmt/v1/health -> 401 application/json; Cache-Control absent
- **Fingerprint:** `/api/mgmt/v1/*|unauthorized response headers|GET non-local|cache-control-no-store-missing`
- **Source fragment fingerprint:** `/api/mgmt/v1/*|unauthorized response headers|GET non-local|cache-control-no-store-missing` (not merged across fragments)
- **Likely owning area:** `src/app/api/mgmt/v1/_lib/http.js`, `src/app/api/mgmt/v1/health/route.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-006 — Light theme selection leaves the UI dark

- **Severity:** P2
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard` — Menu > Theme
- **Preconditions:** S1 isolated browser; settled dashboard; root initially dark
- **Reproduction:**
  1. Open Menu
  2. Activate Theme
  3. Inspect persisted theme and document root
- **Expected:** Selecting light theme removes the dark class and visibly renders the light theme.
- **Actual:** The persisted theme changes to light, but document.documentElement retains the dark class and the UI remains dark.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `theme-toggle-stuck-dark.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard|Theme|select-light|root-remains-dark`
- **Source fragment fingerprint:** `/dashboard|Theme|select-light|root-remains-dark` (not merged across fragments)
- **Likely owning area:** `src/shared/components/layouts/DashboardLayout.js`, `src/shared/components/HeaderMenu.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-007 — Basic Chat cannot start a same-model conversation

- **Severity:** P2
- **Owner/surface:** S3-routing
- **Exact route/control:** `/dashboard/basic-chat` — New conversation
- **Preconditions:** a conversation with messages exists in History
- **Reproduction:**
  1. Open Basic Chat
  2. Complete or populate one conversation
  3. Inspect header, History, and composer actions
  4. Try to start a new conversation with the same model while preserving the existing chat
- **Expected:** A named New conversation action starts a fresh same-model session and keeps the current session in History.
- **Actual:** No New conversation action exists. Clear deletes the active session; only switching provider/model conditionally creates a new session.
- **Sanitized evidence:** [S3-routing evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) — `basic-chat-controls.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/basic-chat|New conversation|inventory|same-model-new-chat-control-absent`
- **Source fragment fingerprint:** `/dashboard/basic-chat|New conversation|inventory|same-model-new-chat-control-absent` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-008 — Stopping generation leaves a blank assistant turn

- **Severity:** P2
- **Owner/surface:** S3-routing
- **Exact route/control:** `/dashboard/basic-chat` — Stop
- **Preconditions:** seeded local model selected; X-QA-Synthetic-State pending stream; no external traffic
- **Reproduction:**
  1. Send QA stop chat
  2. While the request is pending, activate Stop
  3. Inspect the transcript
- **Expected:** The provisional assistant turn is removed or visibly marked cancelled/stopped.
- **Actual:** Stop aborts the request and removes the Stop button, but leaves a blank assistant turn with no cancelled/stopped status.
- **Sanitized evidence:** [S3-routing evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) — `basic-chat-stop.json`
- **Console/network:** console: none; network: synthetic pending POST /api/dashboard/chat/completions aborted locally; no upstream request
- **Fingerprint:** `/dashboard/basic-chat|Stop|abort-stream|blank-unresolved-assistant-turn`
- **Source fragment fingerprint:** `/dashboard/basic-chat|Stop|abort-stream|blank-unresolved-assistant-turn` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-009 — Create Combo modal leaks keyboard focus

- **Severity:** P2
- **Owner/surface:** S3-routing
- **Exact route/control:** `/dashboard/combos` — Create Combo modal
- **Preconditions:** seeded QA server; desktop viewport; pointer-open Create Combo
- **Reproduction:**
  1. Open Create Combo
  2. Inspect dialog semantics and active element
  3. Press Tab twice
- **Expected:** The modal exposes dialog semantics, moves focus inside, traps Tab/Shift+Tab, and returns focus on close.
- **Actual:** No role=dialog or aria-modal is exposed. Focus remains on the background Create Combo button; Tab moves to background judge and strategy controls instead of modal controls.
- **Sanitized evidence:** [S3-routing evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) — `combo-modal-a11y.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/combos|Create Combo|open-and-tab|focus-escapes-non-dialog-modal`
- **Source fragment fingerprint:** `/dashboard/combos|Create Combo|open-and-tab|focus-escapes-non-dialog-modal` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/combos/CombosPageClient.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-010 — Combo model ID editing is pointer-only

- **Severity:** P2
- **Owner/surface:** S3-routing
- **Exact route/control:** `/dashboard/combos` — Model row value / Click to edit
- **Preconditions:** Create or edit a combo containing a compatible-provider model
- **Reproduction:**
  1. Open Create/Edit Combo
  2. Add a compatible-provider model
  3. Tab through the model row
  4. Try to edit the model ID without a pointer
- **Expected:** The visually clickable model value is focusable and Enter/Space opens its inline editor.
- **Actual:** The model value is a DIV with an onClick handler, no role, and no tabindex. Keyboard focus skips it, so exact compatible model IDs cannot be edited keyboard-only.
- **Sanitized evidence:** [S3-routing evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) — `combo-model-inline-edit.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/combos|Click to edit|keyboard-focus|pointer-only-model-id-editor`
- **Source fragment fingerprint:** `/dashboard/combos|Click to edit|keyboard-focus|pointer-only-model-id-editor` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/combos/CombosPageClient.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-011 — Console disconnection is rendered as an empty stream

- **Severity:** P2
- **Owner/surface:** S4-tools
- **Exact route/control:** `/dashboard/console-log` — Console stream / disconnected state
- **Preconditions:** synthetic block limited to /api/translator/console-logs/stream and removed after check
- **Reproduction:**
  1. Block only the console SSE path
  2. Reload Console
  3. Wait for EventSource error
  4. Inspect visible/status/alert output
  5. Remove block and reload real route
- **Expected:** Disconnected/error state is visible with a reconnect or retry affordance.
- **Actual:** UI remains indistinguishable from connected empty state (“Clear / No console logs yet”); no role=status or role=alert content is rendered.
- **Sanitized evidence:** [S4-tools evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) — `observations.txt`
- **Console/network:** console: none; network: synthetic blocked stream duration=0 transferSize=0; interception removed
- **Fingerprint:** `/dashboard/console-log|Console stream|disconnect|no-visible-connection-state`
- **Source fragment fingerprint:** `/dashboard/console-log|Console stream|disconnect|no-visible-connection-state` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/console-log/ConsoleLogClient.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-012 — Core overlays lack dialog focus management

- **Severity:** P2
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard/endpoint` — Create API Key / shared Modal and confirmation surfaces
- **Preconditions:** S1 isolated browser; desktop; seeded keys
- **Reproduction:**
  1. Focus Create Key
  2. Open Create API Key
  3. Inspect active element and dialog semantics
  4. Tab/Escape
  5. Repeat on one-time key, delete, shutdown, changelog and request-details drawer
- **Expected:** A modal has dialog semantics, moves focus inside, traps focus, closes on Escape where applicable, and returns focus to its opener.
- **Actual:** The overlays have no role=dialog, leave focus on the opener/background, expose background links, and return focus to document body instead of the opener; Language and Change Log also ignore Escape.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `endpoint-create-modal-focus.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/endpoint|Create API Key|open-modal|no-dialog-focus-management`
- **Source fragment fingerprint:** `/dashboard/endpoint|Create API Key|open-modal|no-dialog-focus-management` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`, `src/shared/components/HeaderMenu.js`, `src/shared/components/Drawer.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-013 — Masked media key prevents embedding requests

- **Severity:** P2
- **Owner/surface:** S2-providers
- **Exact route/control:** `/dashboard/media-providers/embedding/custom-embedding-qa-local` — Example / Run
- **Preconditions:** seeded QA server; QA Local Embeddings points to http://127.0.0.1:22129/v1; active gateway key is returned to the browser as a masked prefix ending in a Unicode ellipsis
- **Reproduction:**
  1. Open the QA Local Embeddings media-provider detail
  2. Enter qa-embedding in Model
  3. Leave the prefilled masked API key in place
  4. Activate Run
- **Expected:** The example sends POST /api/v1/embeddings locally and renders the mock numeric vector, or requires a usable key before enabling Run.
- **Actual:** Run fails before any network request because the masked key containing U+2026 is copied into the Authorization header: Failed to read the headers property from RequestInit: String contains non ISO-8859-1 code point. The same masked-key loading pattern exists in the image, TTS, STT, and embedding example components.
- **Sanitized evidence:** [S2-providers evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) — `media-embedding-run.json`, `media-example-key-exposure-sanitized.json`
- **Console/network:** console: none; the error is rendered in the Example card; network: no /api/v1/embeddings request was issued; failure occurred while constructing the browser request headers
- **Fingerprint:** `/dashboard/media-providers/embedding/custom-embedding-qa-local|Example Run|run|masked-key-invalid-authorization-header`
- **Source fragment fingerprint:** `/dashboard/media-providers/embedding/custom-embedding-qa-local|Example Run|run|masked-key-invalid-authorization-header` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/EmbeddingExampleCard.js`, `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-014 — MITM tool disclosures are keyboard unreachable

- **Severity:** P2
- **Owner/surface:** S4-tools
- **Exact route/control:** `/dashboard/mitm` — Antigravity / GitHub Copilot / Kiro card expanders
- **Preconditions:** seeded QA server; MITM stopped
- **Reproduction:**
  1. Open MITM
  2. Observe the three visually expandable cards
  3. Tab through interactive controls
  4. Compare DOM role/tabIndex to pointer action
- **Expected:** Each expandable card header is a named button or disclosure reachable and activatable from the keyboard.
- **Actual:** All three clickable headers have role=null and tabIndex=-1 and are absent from the accessibility action tree; only pointer activation is available.
- **Sanitized evidence:** [S4-tools evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) — `observations.txt`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/mitm|MITM tool card expanders|Tab|keyboard-unreachable-disclosures`
- **Source fragment fingerprint:** `/dashboard/mitm|MITM tool card expanders|Tab|keyboard-unreachable-disclosures` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-015 — Pricing editor lacks modal keyboard behavior

- **Severity:** P2
- **Owner/surface:** S4-tools
- **Exact route/control:** `/dashboard/settings/pricing` — Edit Pricing / Pricing Configuration
- **Preconditions:** seeded QA pricing; S4 browser
- **Reproduction:**
  1. Open Pricing Settings
  2. Activate Edit Pricing
  3. Inspect focus and dialog role
  4. Press Escape
  5. Close with ×
- **Expected:** Editor opens as a labelled modal, moves/traps focus, and Escape closes it with focus returned to Edit Pricing.
- **Actual:** role=dialog count is 0, focus remains on background Edit Pricing, and Escape leaves the editor open; × closes it.
- **Sanitized evidence:** [S4-tools evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) — `observations.txt`
- **Console/network:** console: none; network: GET pricing only; no mutation
- **Fingerprint:** `/dashboard/settings/pricing|Edit Pricing|Escape|modal-remains-open-with-background-focus`
- **Source fragment fingerprint:** `/dashboard/settings/pricing|Edit Pricing|Escape|modal-remains-open-with-background-focus` (not merged across fragments)
- **Likely owning area:** `src/app/dashboard/settings/pricing/page.js`, `src/shared/components/PricingModal.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-016 — Translator Format silently ignores malformed JSON

- **Severity:** P2
- **Owner/surface:** S4-tools
- **Exact route/control:** `/dashboard/translator` — Client Request / Format
- **Preconditions:** seeded QA server; visible Monaco Client Request editor
- **Reproduction:**
  1. Replace Client Request with {bad using visible Monaco surface
  2. Activate Format
  3. Inspect inline text, role=alert, aria-live, and toast output
  4. Clear editor
- **Expected:** Malformed JSON is rejected with visible and programmatically associated feedback.
- **Actual:** Malformed payload remains unchanged and no toast, non-empty alert, aria-live message, or inline error appears.
- **Sanitized evidence:** [S4-tools evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) — `observations.txt`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/translator|Format|malformed-json|silent-no-op-no-validation`
- **Source fragment fingerprint:** `/dashboard/translator|Format|malformed-json|silent-no-op-no-validation` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/translator/page.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-017 — Translator Send silently accepts an empty request

- **Severity:** P2
- **Owner/surface:** S4-tools
- **Exact route/control:** `/dashboard/translator` — Target Request / Send
- **Preconditions:** seeded QA server; empty target request; destination not proven qa-openai/qa-chat
- **Reproduction:**
  1. Leave request empty
  2. Activate Send
  3. Inspect network and validation feedback
- **Expected:** Send is disabled or produces visible validation without outbound traffic.
- **Actual:** Send is enabled; activation makes no request and produces no toast, alert, or inline validation.
- **Sanitized evidence:** [S4-tools evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) — `observations.txt`
- **Console/network:** console: none; network: none; no provider traffic
- **Fingerprint:** `/dashboard/translator|Send|empty-submit|silent-no-op-no-validation`
- **Source fragment fingerprint:** `/dashboard/translator|Send|empty-submit|silent-no-op-no-validation` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/translator/page.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-018 — Request-details errors look like empty results

- **Severity:** P2
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard/usage?tab=details` — Request details results
- **Preconditions:** synthetic GET /api/usage/request-details returns marked 500
- **Reproduction:**
  1. Open Details
  2. Trigger a refetch
  3. Return 500 with X-QA-Synthetic-State: 1
- **Expected:** Show a distinguishable error with a usable retry path.
- **Actual:** The table says No request details found, indistinguishable from a successful empty result, with no error or retry.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `usage-details-500-empty.json`
- **Console/network:** console: none; network: 500 synthetic; X-QA-Synthetic-State: 1
- **Fingerprint:** `/dashboard/usage?tab=details|Request details results|request-500|error-rendered-as-empty`
- **Source fragment fingerprint:** `/dashboard/usage?tab=details|Request details results|request-500|error-rendered-as-empty` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-019 — Inverted usage date ranges are accepted

- **Severity:** P2
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard/usage?tab=details` — Start Date / End Date
- **Preconditions:** populated request details
- **Reproduction:**
  1. Set Start Date to 2026-08-23T00:00
  2. Set End Date to 2026-08-22T00:00
  3. Wait for results
- **Expected:** Reject or clearly explain that Start Date must not be after End Date.
- **Actual:** The inverted range is accepted and the table displays No request details found without validation or error text.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `usage-invalid-date-range.json`
- **Console/network:** console: none; network: request completed; no client validation
- **Fingerprint:** `/dashboard/usage?tab=details|Start Date / End Date|submit-inverted-range|empty-without-validation`
- **Source fragment fingerprint:** `/dashboard/usage?tab=details|Start Date / End Date|submit-inverted-range|empty-without-validation` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-020 — Log auto-refresh is pointer-only

- **Severity:** P2
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard/usage?tab=logs` — Auto Refresh (3s)
- **Preconditions:** direct logs URL; populated logs
- **Reproduction:**
  1. Inspect accessibility tree and DOM
  2. Try keyboard navigation
  3. Activate with pointer twice
- **Expected:** The toggle is a keyboard-focusable switch/checkbox with a name and state.
- **Actual:** It is a click-only DIV with tabIndex -1, no role, and no aria-checked. Pointer toggling works, but keyboard and assistive technology cannot operate or determine its state.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `usage-logs-autorefresh.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/usage?tab=logs|Auto Refresh (3s)|keyboard-navigation|click-only-div`
- **Source fragment fingerprint:** `/dashboard/usage?tab=logs|Auto Refresh (3s)|keyboard-navigation|click-only-div` (not merged across fragments)
- **Likely owning area:** `src/shared/components/RequestLogger.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-021 — Failed usage periods display stale data as current

- **Severity:** P2
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard/usage?tab=overview` — 24h period / usage statistics
- **Preconditions:** Today data loaded; synthetic GET /api/usage/stats?period=24h returns marked 500
- **Reproduction:**
  1. Record Today total requests
  2. Intercept 24h stats with X-QA-Synthetic-State: 1 and status 500
  3. Select 24h
- **Expected:** The failed period is not presented as current data; show an error/retry or explicit stale state.
- **Actual:** 24h becomes visually selected, the prior Today value (23) remains unchanged, and no error, retry, or stale indicator appears.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `usage-stats-500-stale.json`
- **Console/network:** console: none; network: 500 synthetic; X-QA-Synthetic-State: 1
- **Fingerprint:** `/dashboard/usage?tab=overview|24h|stats-500|stale-prior-period-without-error`
- **Source fragment fingerprint:** `/dashboard/usage?tab=overview|24h|stats-500|stale-prior-period-without-error` (not merged across fragments)
- **Likely owning area:** `src/shared/components/UsageStats.js`, `src/app/(dashboard)/dashboard/usage/page.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-022 — Usage table actions are keyboard unreachable

- **Severity:** P2
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard/usage?tab=overview` — Sortable usage table headers and expandable group rows
- **Preconditions:** usage table rendered
- **Reproduction:**
  1. Inspect sortable TH elements and grouped TR elements
  2. Attempt to reach them with Tab
- **Expected:** Sort and expand actions are keyboard-focusable and expose sort/expanded state.
- **Actual:** Clickable TH and TR elements have tabIndex -1 and no button role; sortable headers expose only visual arrows and grouped rows expose no keyboard action.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — source fragment observation
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/usage?tab=overview|Usage table headers|keyboard-navigation|clickable-table-elements-not-focusable`
- **Source fragment fingerprint:** `/dashboard/usage?tab=overview|Usage table headers|keyboard-navigation|clickable-table-elements-not-focusable` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/usage/components/UsageTable.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-023 — Compatibility APIs fail browser CORS preflight

- **Severity:** P2
- **Owner/surface:** S5-api
- **Exact route/control:** `/v1/chat/completions; /v1/messages; /v1beta/models/:model:generateContent` — Cross-origin browser request / CORS preflight
- **Preconditions:** browser origin http://127.0.0.1:22129; target http://127.0.0.1:22128; loopback only
- **Reproduction:**
  1. From a browser page on 127.0.0.1:22129, fetch each target with JSON and Authorization headers
  2. Observe the automatic OPTIONS responses
  3. Observe the fetch promise result
- **Expected:** Preflight includes Access-Control-Allow-Origin for the requesting loopback origin (or `*`) and the browser can issue the API request.
- **Actual:** All OPTIONS return 200 with allow-methods/allow-headers but no Access-Control-Allow-Origin; all three browser fetches reject with TypeError: Failed to fetch.
- **Sanitized evidence:** [S5-api evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) — `cors-browser.json`, `requests-sanitized.json`, `assertions.json`
- **Console/network:** console: browser fetch rejection: TypeError: Failed to fetch; network: OPTIONS 200; Access-Control-Allow-Origin absent on all three routes
- **Fingerprint:** `/v1*|cross-origin browser API request|preflight|missing-access-control-allow-origin`
- **Source fragment fingerprint:** `/v1*|cross-origin browser API request|preflight|missing-access-control-allow-origin` (not merged across fragments)
- **Likely owning area:** `src/app/api/v1/chat/completions/route.js`, `src/app/api/v1/messages/route.js`, `src/app/api/v1beta/models/[...path]/route.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-024 — Advertised model metadata returns not found

- **Severity:** P2
- **Owner/surface:** S5-api
- **Exact route/control:** `/v1/models/info?id=qa-openai/qa-chat` — GET model metadata for advertised model
- **Preconditions:** qa-openai/qa-chat is present in GET /v1/models
- **Reproduction:**
  1. GET /v1/models and confirm qa-openai/qa-chat is advertised
  2. GET /v1/models/info?id=qa-openai%2Fqa-chat
  3. Inspect status and error
- **Expected:** 200 metadata for the advertised, active model.
- **Actual:** 404 not_found: Model not found: qa-openai/qa-chat.
- **Sanitized evidence:** [S5-api evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) — `requests-sanitized.json`, `assertions.json`
- **Console/network:** console: none; network: GET /v1/models/info?id=qa-openai%2Fqa-chat -> 404 application/json
- **Fingerprint:** `/v1/models/info|advertised model metadata|GET seeded id|advertised-model-not-found`
- **Source fragment fingerprint:** `/v1/models/info|advertised model metadata|GET seeded id|advertised-model-not-found` (not merged across fragments)
- **Likely owning area:** `src/app/api/v1/models/info/route.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-025 — LLM model discovery rejects the llm kind

- **Severity:** P2
- **Owner/surface:** S5-api
- **Exact route/control:** `/v1/models/llm` — GET LLM-filtered model discovery
- **Preconditions:** seeded QA server with three active LLM models
- **Reproduction:**
  1. GET /v1/models and confirm the three seeded LLM models are listed
  2. GET /v1/models/llm
  3. Inspect status and error
- **Expected:** 200 OpenAI-compatible filtered list containing qa-openai/qa-chat, qa-responses/qa-response, and qa-anthropic/qa-message.
- **Actual:** 404 invalid_request_error: Unknown model kind: llm; the supported-kind list omits llm.
- **Sanitized evidence:** [S5-api evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) — `requests-sanitized.json`, `assertions.json`
- **Console/network:** console: none; network: GET /v1/models/llm -> 404 application/json
- **Fingerprint:** `/v1/models/llm|LLM model discovery|GET|llm-kind-rejected`
- **Source fragment fingerprint:** `/v1/models/llm|LLM model discovery|GET|llm-kind-rejected` (not merged across fragments)
- **Likely owning area:** `src/app/api/v1/models/[kind]/route.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-026 — Gemini discovery omits an active local model

- **Severity:** P2
- **Owner/surface:** S5-api
- **Exact route/control:** `/v1beta/models` — Gemini-compatible active model discovery
- **Preconditions:** qa-openai/qa-chat successfully serves Gemini generateContent on the same server
- **Reproduction:**
  1. POST generateContent for qa-openai/qa-chat and confirm 200 QA mock reply
  2. GET /v1beta/models
  3. Search the returned model names for models/qa-openai/qa-chat
- **Expected:** Gemini model discovery includes the active model that the Gemini generation endpoint accepts.
- **Actual:** GET succeeds with 741 catalog entries, but models/qa-openai/qa-chat is absent.
- **Sanitized evidence:** [S5-api evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S5-api-sanitized-evidence.json) — `requests-sanitized.json`, `assertions.json`
- **Console/network:** console: none; network: GET /v1beta/models -> 200; active seeded model absent
- **Fingerprint:** `/v1beta/models|Gemini model discovery|GET|active-local-model-omitted`
- **Source fragment fingerprint:** `/v1beta/models|Gemini model discovery|GET|active-local-model-omitted` (not merged across fragments)
- **Likely owning area:** `src/app/api/v1beta/models/route.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-027 — Mobile navigation cannot be dismissed accessibly

- **Severity:** P3
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard` — Mobile navigation drawer
- **Preconditions:** 320x568 and 390x844
- **Reproduction:**
  1. Open mobile menu
  2. Press Escape
  3. Inspect backdrop semantics
  4. Close with Close menu
- **Expected:** Escape closes the drawer and the visual backdrop has an equivalent accessible dismissal action.
- **Actual:** Escape leaves the drawer open; the full-screen backdrop is a click-only DIV with no role, name, or keyboard focus. The named Close menu button works.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `endpoint-create-modal-focus.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard|Mobile navigation drawer|press-escape|drawer-stays-open-and-backdrop-inaccessible`
- **Source fragment fingerprint:** `/dashboard|Mobile navigation drawer|press-escape|drawer-stays-open-and-backdrop-inaccessible` (not merged across fragments)
- **Likely owning area:** `src/shared/components/Sidebar.js`, `src/shared/components/layouts/DashboardLayout.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-028 — Basic Chat icon actions expose glyph names

- **Severity:** P3
- **Owner/surface:** S3-routing
- **Exact route/control:** `/dashboard/basic-chat` — Attach / Send / Stop icon buttons
- **Preconditions:** Basic Chat loaded with and without an active model
- **Reproduction:**
  1. Inspect the accessibility tree for composer actions
  2. Focus Attach, Send, and Stop
- **Expected:** Each icon-only action has a human-readable accessible name such as Attach image, Send message, and Stop generating.
- **Actual:** Accessible names are the Material Symbols glyph strings attach_file, arrow_upward, and stop; no aria-label or visually hidden name is provided.
- **Sanitized evidence:** [S3-routing evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S3-routing-sanitized-evidence.json) — `basic-chat-controls.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/basic-chat|composer icon actions|accessibility-inventory|glyph-string-accessible-names`
- **Source fragment fingerprint:** `/dashboard/basic-chat|composer icon actions|accessibility-inventory|glyph-string-accessible-names` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-029 — Core icon actions lack purposeful names

- **Severity:** P3
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard/endpoint` — Key row icon actions and shared header/pagination icon actions
- **Preconditions:** seeded endpoint page and usage pagination
- **Reproduction:**
  1. Inspect accessibility names for reveal, copy, delete, switches, language, menu, previous and next
- **Expected:** Every icon-only action has a stable, purpose-specific accessible name including row context where needed.
- **Actual:** Several controls expose only Material Symbols text such as visibility, content_copy, delete, grid_view, chevron_left/right, or no name at all; repeated key-row actions are indistinguishable by key.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `endpoint-create-modal-focus.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/endpoint|Key row icon actions|accessibility-inspection|missing-purposeful-accessible-names`
- **Source fragment fingerprint:** `/dashboard/endpoint|Key row icon actions|accessibility-inspection|missing-purposeful-accessible-names` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/endpoint/components/EndpointRow.js`, `src/shared/components/Header.js`, `src/shared/components/Pagination.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-030 — Media example fields lack programmatic labels

- **Severity:** P3
- **Owner/surface:** S2-providers
- **Exact route/control:** `/dashboard/media-providers/{kind}/{id}` — Media Example form fields
- **Preconditions:** seeded custom embedding detail and no-auth Edge TTS detail
- **Reproduction:**
  1. Open a media-provider detail with an Example card
  2. Tab through Model/Endpoint/API Key/Input/Dimensions or Input/Output Format
  3. Inspect each control's accessible name
- **Expected:** Example inputs and selects expose their visible Row labels as accessible names.
- **Actual:** The audited Example inputs/selects have no associated label, id, or aria-label even though visible text labels are rendered beside them.
- **Sanitized evidence:** [S2-providers evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) — `media-embedding-detail-inventory.json`, `media-tts-edge-detail.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/media-providers/{kind}/{id}|Example form fields|Tab|visible-labels-not-programmatically-associated`
- **Source fragment fingerprint:** `/dashboard/media-providers/{kind}/{id}|Example form fields|Tab|visible-labels-not-programmatically-associated` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/EmbeddingExampleCard.js`, `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/TtsExampleCard.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-031 — Settings form controls lack accessible names

- **Severity:** P3
- **Owner/surface:** S4-tools
- **Exact route/control:** `/dashboard/profile; /dashboard/token-saver; /dashboard/agent-library; /dashboard/settings/pricing` — Switches, enablement checkboxes, and pricing numeric fields
- **Preconditions:** seeded QA server; populated S4 routes
- **Reproduction:**
  1. Inspect accessibility tree and live DOM
  2. Enumerate role=switch, checkbox, and numeric input accessible names
- **Expected:** Each form control has a programmatic accessible name matching its visible label.
- **Actual:** Profile and Token Saver switches expose aria-label=null and no accessible text; Agent Library enablement checkboxes and Pricing numeric fields likewise lack programmatic names/label associations.
- **Sanitized evidence:** [S4-tools evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S4-tools-sanitized-evidence.json) — `observations.txt`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/profile|settings form controls|accessibility-inspection|unnamed-controls`
- **Source fragment fingerprint:** `/dashboard/profile|settings form controls|accessibility-inspection|unnamed-controls` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/profile/ProfilePageClient.js`, `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js`, `src/app/(dashboard)/dashboard/agent-library/page.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-032 — Provider modals lack dialog semantics

- **Severity:** P3
- **Owner/surface:** S2-providers
- **Exact route/control:** `/dashboard/providers (+ provider detail, quota, and media modal routes)` — Provider, connection, quota, and custom-embedding modal dialogs
- **Preconditions:** seeded QA server; desktop viewport
- **Reproduction:**
  1. Open Add OpenAI Compatible, Add API Key, Edit Compatible Node, Codex Reset Credit Expiry, or Add Custom Embedding
  2. Inspect accessibility semantics and active element
  3. Dismiss with Escape and inspect focus
- **Expected:** Each modal exposes role=dialog with aria-modal and an accessible title, moves focus inside, traps focus, and returns focus to its trigger when closed.
- **Actual:** The audited modal containers expose no dialog role or aria-modal; document.body remains active on open, and focus returns to body rather than the invoking control after Escape.
- **Sanitized evidence:** [S2-providers evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) — `providers-openai-modal.json`, `provider-add-key-modal.json`, `provider-edit-node-modal.json`, `quota-control-states.json`, `media-custom-embedding-modal.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/providers|Provider modal dialogs|open|missing-dialog-semantics-and-focus-management`
- **Source fragment fingerprint:** `/dashboard/providers|Provider modal dialogs|open|missing-dialog-semantics-and-focus-management` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/providers/components/AddCompatibleModal.js`, `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js`, `src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-033 — New-provider labels and errors are unassociated

- **Severity:** P3
- **Owner/surface:** S2-providers
- **Exact route/control:** `/dashboard/providers/new` — Provider, Authentication Method, API Key, and Display Name fields
- **Preconditions:** seeded QA server; empty Add New Provider form
- **Reproduction:**
  1. Open Add New Provider
  2. Inspect visual labels and each control's programmatic name
  3. Submit the empty form
- **Expected:** Every form control is programmatically associated with its visual label and required errors are associated with the invalid controls.
- **Actual:** The four visual label elements have empty htmlFor values, the controls have no ids/aria-labels, and required error paragraphs are not exposed as role=alert or associated through aria-describedby/aria-invalid.
- **Sanitized evidence:** [S2-providers evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) — `provider-new-inventory.json`, `provider-new-validation.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/providers/new|Add New Provider fields|empty-submit|labels-and-errors-not-programmatically-associated`
- **Source fragment fingerprint:** `/dashboard/providers/new|Add New Provider fields|empty-submit|labels-and-errors-not-programmatically-associated` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/providers/new/page.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-034 — Provider icon actions expose glyph names

- **Severity:** P3
- **Owner/surface:** S2-providers
- **Exact route/control:** `/dashboard/providers/openai-compatible-chat-qa-local` — Connection reorder and model test/copy icon buttons
- **Preconditions:** seeded QA Local Chat detail with three connections; ephemeral detail with two custom models
- **Reproduction:**
  1. Open QA Local Chat detail
  2. Tab through connection move controls and model actions
  3. Inspect the accessibility tree/DOM names
- **Expected:** Icon-only actions have task-oriented accessible names such as Move QA Chat Ready down, Test qa-chat, and Copy qa-chat.
- **Actual:** Several actions have no aria-label/title and expose only Material Symbols ligature text such as keyboard_arrow_down, science, and content_copy; actions are ambiguous to screen-reader users and repeated controls are indistinguishable.
- **Sanitized evidence:** [S2-providers evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S2-providers-sanitized-evidence.json) — `provider-seeded-chat-inventory.json`, `provider-ephemeral-model-controls.json`, `provider-ephemeral-detail-ax.txt`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/providers/openai-compatible-chat-qa-local|Connection and model icon actions|Tab|material-icon-ligature-accessible-names`
- **Source fragment fingerprint:** `/dashboard/providers/openai-compatible-chat-qa-local|Connection and model icon actions|Tab|material-icon-ligature-accessible-names` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`, `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

### QA-035 — Usage controls hide selected and expanded state

- **Severity:** P3
- **Owner/surface:** S1-core
- **Exact route/control:** `/dashboard/usage` — Overview/Details, periods, pagination and request collapsibles
- **Preconditions:** usage overview/details populated
- **Reproduction:**
  1. Inspect current Overview/period/page
  2. Open request collapsible
  3. Inspect ARIA state
- **Expected:** Selected tab/period/page and expanded sections expose programmatic current/pressed/selected/expanded state.
- **Actual:** Segmented buttons have no tab role or aria-pressed/selected, pagination has no aria-current, and collapsible section buttons have no aria-expanded/controls.
- **Sanitized evidence:** [S1-core evidence bundle](evidence/2026-08-22-full-ui-functional-audit/S1-core-sanitized-evidence.json) — `usage-details-500-empty.json`
- **Console/network:** console: none; network: none
- **Fingerprint:** `/dashboard/usage|Usage selection controls|accessibility-inspection|state-not-programmatically-exposed`
- **Source fragment fingerprint:** `/dashboard/usage|Usage selection controls|accessibility-inspection|state-not-programmatically-exposed` (not merged across fragments)
- **Likely owning area:** `src/app/(dashboard)/dashboard/usage/page.js`, `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`, `src/shared/components/Pagination.js`
- **Source changes/fix:** none; audit-only finding. No fix was suggested or attempted.

## Passed coverage

### S1 — core, shell, endpoint, and usage

- `/` redirected to `/dashboard` at all four required viewports.
- `/dashboard` covered the desktop/mobile shell, all navigation links, status and capacity badges, language/grid/changelog/theme menus, safe shutdown boundary, active navigation, light/dark requests, and mobile drawer controls.
- `/dashboard/endpoint` covered both seeded key rows, create/one-time-key/delete confirmations, empty-name and delayed-failure boundaries, copy/reveal/pause/resume, one ephemeral key lifecycle, masking after reload, and focus/keyboard inspection. The generated key value was never recorded.
- Usage overview covered Overview/Details navigation, five periods, token/cost and grouping controls, cards, chart, topology, grouped/sortable table, recent requests, loading, zero, synthetic 500, history, and all four viewports.
- Usage details covered provider/date filters, clear, populated/empty/500 states, 27 rows over two pages, rows-per-page, pagination, request drawer/collapsibles, and keyboard/focus behavior. Direct logs covered loading/populated/empty/500-refresh states and auto-refresh.

### S2 — providers, quota, and media

- `/dashboard/providers` and `/providers/new` covered search/clear, category test boundaries, custom-provider menus and forms, built-in expansion, badges, validation, and no-result states.
- Four seeded provider details plus one ephemeral detail covered compatible-node edit/delete, single/bulk keys, connection ordering/toggle/edit/delete/test, model add/import/test/copy/remove, badges, loading/empty/error inventory, and complete removal of S2-owned records.
- `/dashboard/quota` covered provider/account/status/sort/expiry filters, bulk enable/disable, auto-refresh/countdown, refresh, reset-credit view, edit/delete, pagination/page size, and synthetic loading/empty/401/500 states at all four viewports. All quota traffic remained intercepted.
- Media hub and Image/TTS/STT/Embedding/Web routes covered tabs/cards/badges, custom embedding, forms, model/connection controls, copy/run boundaries, voice/output controls, and all four viewports on representative dense surfaces. Only the local embedding send boundary was attempted.

### S3 — combos, routing, and Basic Chat

- `/dashboard/combos` covered all three seeded strategies, create/edit/delete and `qa-s3-ephemeral` lifecycle, model picker/order/edit, Fusion/Auto mode-dependent controls, capacity badges, relearn/freeze/feedback boundaries, validation, keyboard, and all four viewports.
- Routing without a combo covered the help/back state. `?combo=qa-auto` covered real no-history, local insufficient-events relearn, synthetic rich charts/versions/feedback, delayed stale refresh, empty, frozen, and 500/retry states.
- Basic Chat covered model-group loading/picker, composer, Enter and Shift+Enter, attachment/remove, transcript/history/clear, send/stop states, and all four viewports. Its primary send failure is QA-001 rather than a coverage gap.

### S4 — tools, settings, skills, console, and MITM

- The CLI hub inventoried 19 CLI cards and three MITM cards. Fully settled detail coverage was recorded for Claude, OpenClaw, Codex, OpenCode, Hermes, Cursor, Kilo, Roo, Continue, Qwen, JCode, Grok, Pi, and Aider; common controls included expand/help boundaries, endpoint/key/model fields, Apply/Reset safe boundaries, manual configuration, copy, selectors, badges, and keyboard paths.
- Agent Library, Token Saver, Translator, Profile, Pricing, Skills and skill-readable/raw routes, Console Log, and MITM were inventoried for their live controls, forms, modals, tabs, toggles, dropdowns, badges, state boundaries, keyboard paths, and prohibited-action boundaries. Dynamic-state limitations are isolated below and are not product findings.
- `/dashboard/skills`, `/dashboard/skills/switchboard`, `/dashboard/skills/switchboard-chat`, `/api/skills/switchboard`, and `/api/skills/switchboard-chat` covered readable/raw content, copy/open navigation, badges, and 404/error boundaries.

### S5 — compatibility and management APIs

- `/api/health`: **pass** — success.
- `/v1; /v1/models; /api/v1/models`: **pass** — success, populated.
- `/v1/models/llm`: **fail** — error.
- `/v1/models/info`: **fail** — missing-id validation, advertised seeded model lookup.
- `/v1beta/models`: **fail** — success, populated, active model omitted.
- `/v1/chat/completions; /v1/v1/chat/completions`: **fail** — success, SSE, auth failure, invalid model, invalid body, loopback exemption, CORS.
- `/v1/responses; /responses; /codex`: **pass** — success, auth failure.
- `/v1/responses/compact`: **pass** — invalid JSON.
- `/v1/messages`: **fail** — success, CORS.
- `/v1/messages/count_tokens`: **pass** — success, invalid JSON.
- `/v1beta/models/:model:generateContent; /v1beta/models/:model:streamGenerateContent`: **fail** — success, SSE, CORS.
- `/v1/api/chat`: **fail** — success status with empty content.
- `/v1/embeddings`: **pass** — success.
- `/v1/images/generations`: **pass** — error.
- `/v1/audio/speech; /v1/audio/transcriptions`: **pass** — error.
- `/v1/search; /v1/web/fetch`: **pass** — error.
- `/api/mgmt/v1/health; /api/mgmt/v1/version`: **fail** — success, auth failure, headers.
- `/api/mgmt/v1/providers; /api/mgmt/v1/combos`: **pass** — success, redacted.
- `/api/mgmt/v1/usage; /api/mgmt/v1/routing`: **pass** — success, invalid period, empty seeded routing.

The API matrix also covered auth negatives, intentional trusted-loopback exemption, invalid JSON/body/model paths, SSE termination, aliases/rewrites, redacted management envelopes, no-store success responses, and usage deltas. All successful provider-backed bodies carried QA mock markers and all targets were loopback.

## Environment, safety, and coverage limitations

These items are not product findings and were not assigned QA IDs.

### Environment/runtime limitations

- Concurrent Next.js development compilation caused 18–30 second requests, Fast Refresh/ChunkLoadError noise, navigation timeouts, and one late 30-second health/root timeout. Workers excluded transient compile behavior and filed only settled, reproducible product observations.
- S2 screenshot capture repeatedly timed out in `Page.captureScreenshot`; S2 therefore relied on sanitized DOM, accessibility, and request evidence. No screenshot-only claim was retained.
- S4 CDP viewport changes and several navigations timed out during concurrent compilation. The exact four-viewport sweep is therefore unverified for S4 even though live 1200×953 observations showed no horizontal overflow on the populated routes reached.
- S4 dynamic populated/error terminal states were not reliably reachable for Cowork, Droid, Cline, DeepSeek TUI, and Gemini CLI because status checks remained in `Checking` or shell-only states. CLI Apply/Reset was not exercised after safe-path proof because a stable write cycle could not be completed.
- The S4 Agent Library route was inventoried, including a dry-run result, but full dynamic synthetic state coverage remained limited by the same development-server stalls.
- S1 did not replace the active React Query key cache with a synthetic empty response because doing so safely would have required deleting seeded keys. The source and live empty-state boundary were inventoried; seeded records were preserved.
- S2 could not open a media combo detail because the seeded UI exposed zero Web Search/Web Fetch combos. Its provider-list 404/500 reload probes were also incomplete under repeated development compilation.
- Exact Chromium and Node.js version strings and per-worker completion timestamps were absent from the result interface.

### Safety-gated controls

- **S1-core:**
  - Shutdown modal opened, accessible names and Escape/Cancel tested; Shutdown confirm NOT EXECUTED — safety gate
  - Update banner/source and both update modals inventoried; Continue, Copy & shutdown, updater execution, and shutdown NOT EXECUTED — safety gate
  - No external provider traffic, OAuth, MITM, DNS/hosts, certificate, sudo, port-443, Headroom, host process, update, or real-user-state actions were executed
  - Full generated key was verified once only by boolean shape/length and was never logged or screenshotted
- **S2-providers:**
  - Test All for OAuth, Free, and API Key providers NOT EXECUTED — safety gate; built-ins may call external providers.
  - OAuth authorize/exchange/import, cookie import, bulk external token flows NOT EXECUTED — safety gate; modals/controls inventoried only.
  - External provider tests, external catalogs, external model refreshes, proxy tests, and paid traffic NOT EXECUTED — safety gate.
  - Only QA S2 Ephemeral at http://127.0.0.1:22129/v1 was validated/tested/imported; it and its connection/models were removed.
  - Quota client, usage, reset-credit, and synthetic-row mutation paths were intercepted in-browser with X-QA-Synthetic-State: 1; no quota call reached the server.
  - Codex reset-credit confirmation and auto-ping NOT EXECUTED — safety gate; expiry/empty-credit view only.
  - Image, TTS, STT, and web example sends NOT EXECUTED — safety gate; forms and disabled/validation boundaries inventoried.
  - Custom embedding Run was the only media send attempted; it failed before network construction, so no paid/external or upstream request occurred.
  - No real credential import, user home/profile, external provider, OAuth flow, host mutation, MITM, Headroom, update, or shutdown action was accessed.
- **S3-routing:**
  - No external model/provider request was executed; all successful or synthetic calls were loopback-only.
  - Relearn was executed only for qa-auto and returned Need 50 more requests before first learn (min 50).
  - No real Promote or Rollback was executed because the real seed had no S3-created learning versions; synthetic rich-version controls were inventoried with X-QA-Synthetic-State responses.
  - No seeded combo was deleted; only qa-s3-ephemeral was created and removed.
  - No database import/reset, build, test, lint, format, server restart, shutdown, OAuth, provider test, or prohibited host action was executed.
- **S4-tools:**
  - MITM Start Server reached sudo modal only; Confirm not executed.
  - MITM Trust Cert, Stop Server, port-443 force-kill, and per-tool DNS Start/Stop not executed.
  - Headroom setup/status modal inspected; Start/Stop/proxy actions not executed.
  - Agent Library Doctor not executed; project scope, catalog install/update, clean-managed, and external export mutations not executed.
  - Shutdown modal opened and dismissed; Shutdown and Copy & shutdown not executed.
  - Updater/update catalog, external CLI install/help launch, real CLI config writes, and host process launch/kill not executed.
  - Translator Send was exercised only at empty validation boundary; no external/model traffic occurred.
  - Database import was not executed; backup export path setup was attempted only under QA_ROOT and no downloaded file appeared.
- **S5-api:**
  - All audit HTTP targets restricted to 127.0.0.1 ports 22128/22129
  - No management/resource mutation requests executed
  - Shutdown, update, import/reset, OAuth, MITM, Headroom, host/destructive actions not invoked
  - Authorization/x-api-key values masked; cookies not captured
  - No external provider endpoint contacted
  - No repository files changed; no tests/build/lint/format run
  - Ego-browser task space used only for CORS and SSE termination evidence

## Isolation, containment, and restoration proof

- Readiness verified both loopback services healthy, the isolated database import successful, and the deterministic warm requests returning only QA mock markers. Provider inventory exposed only `127.0.0.1:22129` base URLs; SSRF allow-hosts contained only loopback; outbound proxying was disabled.
- S1 created and deleted exactly one `QA S1 Ephemeral` key. Final key inventory contained only the two seeded rows; Require API Key, locale, and dark theme state were restored.
- S2 removed its ephemeral provider node, connection, and custom models. Final API state contained exactly four seeded nodes and six seeded connections, with seeded statuses unchanged.
- S3 removed `qa-s3-ephemeral`, preserved all seeded combos, and restored the exact seeded strategy configuration.
- S4 proved selected CLI configuration paths resolved under the isolated HOME. The fake-HOME manifest SHA-256 was identical before and after (`ee6b583af202d0bdbdc1a69632458464036b92552cf439f9330bb764979ef6b7`, four files). Locale, theme, API-key requirement, combo strategies, proxy, observability, RTK/Headroom/Caveman/Ponytail, and vault settings were restored to the seeded values.
- S5 performed no management or resource mutation. Usage rose only through the local compatibility matrix and browser probes; authorization and cookies were masked or not captured.
- Synthetic browser responses were tagged `X-QA-Synthetic-State: 1`, scoped to owned endpoints, removed after use, and never used to claim a backend defect.

## Recommended fixing order for the next session

This is prioritization only; it does not prescribe implementation changes.

1. **Primary-flow failures:** QA-001 and QA-004, because they drop the central Basic Chat/Ollama response paths.
2. **Destructive-confirmation accessibility:** QA-002 and QA-003, because host/shutdown actions require an unambiguous keyboard-safe boundary.
3. **Protocol and discovery correctness:** QA-005, QA-023, QA-024, QA-025, and QA-026, because client integration contracts are affected across management, CORS, OpenAI discovery, and Gemini discovery.
4. **Data/state integrity in user flows:** QA-006, QA-007, QA-008, QA-011, QA-013, QA-016, QA-017, QA-018, QA-019, and QA-021.
5. **Modal and keyboard operability:** QA-009, QA-010, QA-012, QA-014, QA-015, QA-020, and QA-022.
6. **Remaining accessibility semantics:** QA-027 through QA-035, grouped by owning component without assuming one cross-component fix.

## Repository integrity

- Audit-created repository artifacts are limited to this ledger and the five cited sanitized evidence bundles under `docs/qa/evidence/2026-08-22-full-ui-functional-audit/`. The existing QA plan is the only other allowed audit document.
- Evidence bundles omit screenshots and absolute runtime paths, mask credential-bearing values, and retain only cited text/DOM/network material plus source fragment observations.
- No application, test, configuration, package, lockfile, migration, or fixture file was edited. No fixes were attempted.
- No validation suite was run, per the audit constraint.
