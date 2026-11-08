# Upstream port: November 2026

Upstream: decolua/9router through `1fe586bb` (v0.5.112).
Previous parity baseline: August 2026, approximately v0.5.55.

## Released in v0.9.68

The initial port includes streaming and translation fixes, IPv6 SSRF hardening,
Responses API authentication, request-scoped combo fallback, proxy validation,
database cleanup, model catalogs and quota trackers, Codex profiles, provider
and combo filtering, video, embeddings, speech and search integrations.

The follow-up restores OpenCode Free's `/inference/v1` transport, canonical
sessions and client tools, with a TLS client loaded on demand. OpenCode Free/Go
also support the Muse Responses chain, model-specific endpoint routing, strict
tool payload normalization, thinking metadata, and terminal-event output recovery.

## Completed for v0.9.69

- Per-key model and combo restrictions, wildcard allow/deny rules, token quotas,
  catalog filtering, and paused-key enforcement. Rules apply to aliases, nested
  combos, search/fetch targets and model discovery.
- Cline free-model feed and envelope normalization; Airforce free chat models,
  guarded live discovery and suggestions.
- Provider custom header overrides, including specialized inference transports.
- Persisted Gemini thought signatures, read before translation after restart,
  isolated by client/account/session and retained for streaming and nonstreaming
  tool calls. Gemini, Responses and CommandCode headroom projections.
- Auto-ping schedules at fixed local times.
- Smart Router/System One decisions, sticky sessions, adaptive hysteresis,
  confidence thresholds, fail-open behavior and dashboard policy configuration.
- Zed hosted models with native RSA browser sign-in, guarded local IDE import,
  live model discovery, plan quota display and multi-format inference.
- Z.ai OAuth alongside GLM API-key authentication, OpenCode Zen PAYG, AWS Bedrock
  Anthropic/xAI with static or local AWS profile/SSO credentials, MiniMax Code
  global/CN OAuth and desktop leases, and Nous OAuth/API-key connections.
- Antigravity Sonnet/Opus 5.5 tiers, model-family quota routing and effort-to-tier
  resolution.
- Ollama local TTS, cloud web fetch/search and GLM search; Codex OAuth STT and
  Gemini Live STT. Audio decoding requires ffmpeg for Codex and container uploads
  to Live; raw PCM16 can use Live directly. Live uses Google's RPC WebSocket,
  top-level setup acknowledgement and PCM audio frames; an interrupted session
  returns a retryable error instead of silently losing uploaded audio.
- Qoder CN region handling, queue polling without replaying inference, bounded
  deadlines, context tiers, billing and attachment uploads.
- Grok CLI bulk imports; analytics Requests mode and provider/model charts;
  custom-model vision/reasoning capabilities; lazy-loaded dashboard charts.
- Hermes named profiles, role models, audio configuration, scoped apply/reset,
  and atomic YAML/environment updates preserving unrelated settings.
- Standalone CLI `connect` and redacted offline `show`, sharing the dashboard's
  configuration writers. Connect mints a fresh gateway key, never reads saved
  gateway secrets, writes locally, and revokes unused keys. Optional saved login
  is origin-bound and mode 600; full secret output requires `--print-env`.

## Switchboard adaptations

Existing credential storage, central authentication, proxy selection, outbound
identity, SSRF/redirect guards, client-key policy and usage accounting remain the
integration points. Gateway responses do not add wildcard CORS, and browser
localStorage does not store credentials. Tests use disposable data directories.
AWS profile resolution uses the lazily imported optional
`@aws-sdk/credential-providers` dependency; static credentials do not load it.

Web-cookie/browser-pool providers, Xiaomi desktop login and relay proxy pools
are intentionally outside this port's scope.

## Release validation

The combined Linux suite passes 781 test files and 6,439 tests, with 14 files
and 63 tests skipped. Lint, locale coverage, generated-provider checks and
package-version parity pass. The docs dependency audit reports no vulnerabilities,
and the docs production build passes.

The final v0.9.69 CLI archive builds successfully. An isolated extraction starts
the packaged server, reports version 0.9.69, returns healthy application/database
checks and the expected 307 root redirect, and loads the AWS credential SDK and
standalone configuration writers. Provider protocol tests use offline fixtures;
these checks do not establish live connectivity for every provider account.
