# Switchboard

One local endpoint for every AI model you use.

```text
http://127.0.0.1:20128/v1
```

Connect provider accounts once, create a Switchboard API key, then point Claude Code, Codex, Cursor, Cline, or any OpenAI-compatible client at the gateway. Switchboard handles format translation, account fallback, model routing, quota visibility, and usage tracking locally.

## Start Here

1. [Install Switchboard](getting-started/installation).
2. Open `http://127.0.0.1:20128/dashboard`.
3. Add at least one account under **Providers**.
4. Create a key under **Endpoint & keys**.
5. Configure a client from **CLI tools**, or use the `/v1` endpoint directly.

The [Quick Start](getting-started/quick-start) walks through the complete flow.

## Routing

- **Direct models** send a request to the provider and account represented by that model ID.
- **Fallback combos** try models in order until one succeeds.
- **Round-robin combos** spread requests across a pool.
- **Fusion combos** ask several models and use a judge model to synthesize the result.
- **Auto combos** use a router model to select a worker for each request and can learn from outcomes over time.

Switchboard also falls back across multiple accounts for the same provider and refreshes supported OAuth credentials automatically.

## Dashboard

| Area | Purpose |
|---|---|
| Overview | Recent requests, provider state, and gateway health |
| Combos | Fallback, round-robin, fusion, and Auto routing |
| Usage | Request history, tokens, cached tokens, and estimated cost |
| Quota | Provider quota and reset information when available |
| Providers | OAuth, API-key, compatible, local, and free provider connections |
| Endpoint & keys | Base URL, gateway authentication, and API-key management |
| Token saver | Fail-open compression and token diagnostics |
| Media | Image, TTS, STT, embedding, search, and fetch providers |
| Skills | Agent-readable Switchboard product skills |
| Agent library | Sync namespaced skills and MCP servers into supported agents |
| CLI tools | Generate or apply client-specific configuration |
| Settings | Runtime preferences, logs, data, updates, and diagnostics |

## API Surface

Switchboard exposes OpenAI-compatible routes for models, chat completions, Responses, embeddings, image generation, speech, transcription, search, and web fetch. Provider and model capabilities vary; use the dashboard or `/v1/models` as the source of truth.

## Local-First Security

The dashboard and credential-management routes are local-only. The `/v1` gateway requires an API key by default when reached from outside loopback. Switchboard does not provide a hosted cloud endpoint or public tunnel; if you expose it through your own proxy, secure it with TLS and keep gateway authentication enabled.
