# FAQ

## What is Switchboard?

Switchboard is a local routing gateway for AI clients. It exposes one OpenAI-compatible `/v1` endpoint and routes requests to the providers you connect.

## Is there a hosted Switchboard cloud?

No. The current app is local-first. You can run it locally or in Docker. If you publish it yourself behind a reverse proxy, you are responsible for auth, TLS, and network security.

## What port does it use?

The packaged app uses port `20128`.

```text
Dashboard: http://localhost:20128/dashboard
API:       http://localhost:20128/v1
```

## Which providers are supported?

Use the **Providers** page as the source of truth. The registry includes OAuth providers, API key providers, local/self-hosted providers, and media providers.

## How do I know the right model name?

Do not copy model names from old examples. Use the dashboard model picker or call:

```bash
curl http://localhost:20128/v1/models \
  -H "Authorization: Bearer sk_switchboard"
```

## What are combos?

Combos are named groups of models. You can route with fallback, round-robin, fusion, or Auto. Use the combo name as the request model.

## How do thinking and reasoning controls work?

Clients send thinking in different shapes: Claude `thinking`, OpenAI `reasoning_effort`, Gemini `thinkingConfig`. Switchboard translates each into the spelling the target model's gateway accepts — including the per-model formats captured from custom OpenAI-compatible providers when you click **Import models** — and strips thinking parameters for models with no reasoning control instead of failing the request (see **Providers**).

## Does usage tracking include quota?

Switchboard tracks requests and token usage for traffic through its endpoint. Quota details depend on the provider; not every provider exposes quota or reset data.

## Can I use Cursor?

The app has a Cursor guide in **CLI Tools**, but Cursor may need a public URL because some Cursor requests go through Cursor infrastructure. Switchboard does not provide that public URL.

## Is an API key required?

The app supports a **Require API key** setting in **Endpoint & Keys**. Keep it enabled, especially if the service is reachable beyond your own machine.

## Where is data stored?

By default:

```text
~/.switchboard
```

Set `DATA_DIR` to use another location.
