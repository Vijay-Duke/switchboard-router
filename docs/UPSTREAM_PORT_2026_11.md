# Upstream port: November 2026

Upstream: decolua/9router through `1fe586bb` (v0.5.112).
Previous parity baseline: August 2026, approximately v0.5.55.

## Included

The initial port on master includes streaming and translation fixes, IPv6 SSRF
hardening, Responses API authentication, request-scoped combo fallback, proxy
validation, database cleanup, new model catalogs and quota trackers, Codex
profiles, provider and combo filtering, video, embeddings, speech and search
integrations. Switchboard's proxy, credential storage and CORS rules are retained.

The follow-up restores OpenCode Free's `/inference/v1` transport, canonical
sessions and client tools, with an optional TLS client loaded on demand. It also
adds the OpenCode Free/Go Muse Responses chain, model-specific endpoint routing,
strict tool payload normalization, thinking metadata, and complete output when a
Responses backend only includes it in the terminal event.

## Still deferred

The GLM pass completed OpenCode Free and started the Responses chain, which was
completed during integration review. It did not implement the rest of its brief:

- Per-key model/combo restrictions and token quotas.
- Cline free-tier feed, provider custom headers, Gemini thought signatures and
  the remaining headroom projections.
- Scheduled auto-ping, Smart Router/System One and Zed.
- Z.ai OAuth, OpenCode Zen PAYG and additional Antigravity tiers.
- Ollama TTS/web fetch/search, Grok CLI bulk import and remaining analytics UI.
- Bedrock, MiniMax Code, Qoder rewrite/CN, Nous, Gemini Live STT, Hermes profiles
  and a secret-safe CLI connect/show flow.

Web-cookie providers, Xiaomi desktop login and relay proxy pools remain outside
this port's scope. Deferred items require separate implementation and review;
they are not part of the released feature set.
