---
name: switchboard
description: Entry point for Switchboard — intelligent model-routing gateway with one OpenAI-compatible /v1 endpoint, multi-provider accounts, and combo strategies (fallback, round-robin, fusion, Auto). Use when the user mentions Switchboard, SWITCHBOARD_URL, combos, Auto routing, or wants chat/code through a local gateway without provider boilerplate.
---

# Switchboard

Local AI routing gateway: one OpenAI-compatible endpoint, many providers, model combos with Auto (router → worker), fallback, round-robin, and fusion. Dashboard for keys, combos, usage, and routing insights.

## Setup

```bash
export SWITCHBOARD_URL="http://localhost:20128"      # or VPS / tunnel URL
export SWITCHBOARD_KEY="sk_switchboard"              # from Dashboard → Endpoint & keys (only if requireApiKey=true)
```

All requests: `${SWITCHBOARD_URL}/v1/...` with header `Authorization: Bearer ${SWITCHBOARD_KEY}` (omit if auth disabled).

Verify: `curl $SWITCHBOARD_URL/api/health` → `{"ok":true}`

## Point any OpenAI-compatible client

```bash
export OPENAI_BASE_URL="$SWITCHBOARD_URL/v1"
export OPENAI_API_KEY="$SWITCHBOARD_KEY"
```

Works with Claude Code, Codex, Cline, Cursor, Continue, and similar tools.

## Discover models

```bash
# Chat / LLM models (and combos with owned_by:"combo")
curl $SWITCHBOARD_URL/v1/models | jq '.data[].id'

# Per-model metadata
curl "$SWITCHBOARD_URL/v1/models/info?id=openai/gpt-4o"
```

Use `data[].id` as the `model` field. Prefer a **combo name** (e.g. `auto`) when the dashboard has Auto/fallback configured — Switchboard picks or fails over workers for you.

Response shape:

```json
{
  "object": "list",
  "data": [
    { "id": "openai/gpt-5", "object": "model", "owned_by": "openai", "created": 1735000000 },
    { "id": "auto", "object": "model", "owned_by": "combo", "created": 1735000000 }
  ]
}
```

## Combos & Auto routing

Combos are dashboard-defined groups of models:

| Strategy | Behavior |
|----------|----------|
| **fallback** | Try models in order until one succeeds |
| **round-robin** | Rotate traffic across models |
| **fusion** | Parallel panel + judge merge |
| **Auto** | Router LLM picks one worker from the pool every request; outcomes feed learning |

Use the combo’s `name` as `model` in chat requests. Configure router, objective, and pool under **Dashboard → Combos**. Routing insights / relearn: **Combos → Routing insights**.

## Capability skill

| Capability | Agent URL (with server running) |
|------------|----------------------------------|
| Chat / code-gen (OpenAI + Anthropic formats) | `$SWITCHBOARD_URL/api/skills/switchboard-chat` |

On disk: `skills/switchboard-chat/SKILL.md`.

## Errors

- **401** → set/refresh `SWITCHBOARD_KEY` (Dashboard → Endpoint & keys)
- **400** `Invalid model format` → check `model` exists in `/v1/models`
- **503** `All accounts unavailable` / all combo workers failed → wait `retry-after` or add provider accounts
