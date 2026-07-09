# Switchboard — Agent Skills

Drop-in skills for coding agents (Claude Code, Cursor, Codex, custom SDKs). **Copy a link** from the dashboard **Skills** page and paste it to your AI.

Product scope: **intelligent chat/model routing** (providers, combos, Auto, dashboard) — not multi-modal media APIs.

> Start with the **switchboard** entry skill — setup, discovery, combos/Auto, then chat.

## Skills

With Switchboard running (default `http://localhost:20128`):

| Skill | Agent URL (raw markdown) | Dashboard view |
|-------|--------------------------|----------------|
| **Entry / Setup** | `$SWITCHBOARD_URL/api/skills/switchboard` | `/dashboard/skills/switchboard` |
| Chat / code-gen | `$SWITCHBOARD_URL/api/skills/switchboard-chat` | `/dashboard/skills/switchboard-chat` |

On disk: `skills/<id>/SKILL.md`.

## How to use

```
Read this skill and use it: http://localhost:20128/api/skills/switchboard
```

Then ask normally — point clients at `$SWITCHBOARD_URL/v1`, use a combo name (e.g. `auto`) as `model` when configured.

## Configure your shell once

```bash
export SWITCHBOARD_URL="http://localhost:20128"
export SWITCHBOARD_KEY="sk_switchboard"   # Dashboard → Endpoint & keys if requireApiKey
export OPENAI_BASE_URL="$SWITCHBOARD_URL/v1"
export OPENAI_API_KEY="$SWITCHBOARD_KEY"
```

Verify: `curl $SWITCHBOARD_URL/api/health` → `{"ok":true}`.
