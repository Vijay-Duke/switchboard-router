# Switchboard

Switchboard gives your AI tools one local endpoint:

```text
http://localhost:20128/v1
```

Add provider accounts in the dashboard, create API keys, and point clients at Switchboard instead of wiring every tool to every provider.

## What It Does

- Serves OpenAI-compatible `/v1` endpoints for chat, responses, models, embeddings, images, audio, search, and fetch.
- Stores provider connections, API keys, combos, usage, and request details locally.
- Lets you group models into combos with fallback, round-robin, fusion, or Auto routing.
- Includes dashboard helpers for CLI tools such as Claude Code, Codex, Cursor, Cline, Roo, Continue, OpenCode, Aider, Gemini CLI, and others.

## What It Is Not

Switchboard is local-first. The current app does not ship a hosted cloud endpoint, public tunnel service, team billing system, or fixed pricing tiers. If you expose it yourself, secure it like any other local service.

## First Steps

1. Install and run Switchboard.
2. Open `http://localhost:20128/dashboard`.
3. Add at least one provider.
4. Create an API key in **Endpoint & Keys**.
5. Use `http://localhost:20128/v1` as your client base URL.

Start with [Quick Start](getting-started/quick-start).
