# CLI Tools

The dashboard has a **CLI Tools** page for configuring supported tools on your machine.

## Supported From The App

The current app includes helpers or guides for Claude Code, Codex, Cursor, Cline, Roo, Continue, OpenCode, Open Claw, Aider, Gemini CLI, Qwen Code, Kilo Code, DeepSeek TUI, jcode, Grok CLI, Pi, Factory Droid, Hermes Agent, and Claude Cowork.

It also includes MITM setup pages for Antigravity, GitHub Copilot, and Kiro.

## Use The Dashboard First

Open:

```text
http://localhost:20128/dashboard/cli-tools
```

Pick a tool and follow the generated setup. The dashboard can use your current API key, base URL, and selected models instead of hard-coded examples. Tools with native model catalogs can register several models; tools that store only one active default keep a single default selector and can still switch models through their own runtime controls when supported.

## Claude Code Workflows

Claude Code has two Switchboard workflows that can be configured at the same time:

| Workflow | Authentication and routing |
| --- | --- |
| **Subscription hybrid (recommended)** | Normal `claude` sessions keep using the OAuth session already held by Claude Code. Leave a built-in Opus, Sonnet, Fable, or Haiku slot empty to keep that native subscription model, or map the slot to a Switchboard model. The mapped slots stay switchable through Claude Code's normal `/model` picker and can be selected by subagents through the corresponding `opus`, `sonnet`, `fable`, or `haiku` alias. |
| **Curated Switchboard catalog** | Choose the Switchboard LLMs and combos you want to publish, then use the separate `claude-switchboard` launcher. Only those selected entries appear in `/model`, and their IDs can be used by custom subagents. Claude subscription OAuth is not used in this launcher; Claude models require an Anthropic-compatible provider credential configured in Switchboard. |

The workflows use separate settings. Subscription hybrid updates `~/.claude/settings.json` with a recoverable backup. Full Catalog writes a dedicated profile under the Switchboard data directory and launches it at command-line precedence, so it does not replace the user's normal Claude configuration, agents, skills, or project settings.

Example hybrid slots:

```text
Opus   → Native Claude Opus
Sonnet → openai/gpt-5.6
Fable  → deepseek/deepseek-v3
Haiku  → gemini/gemini-3.1-pro
```

Run `claude` and use `/model` to switch among those visible slots. Run `claude-switchboard` when you want the separate curated list of provider models and combos.

### Claude Code API

The dashboard uses composable local API primitives that scripts and agents can call directly:

- `GET /api/cli-tools/claude-settings` reports installation status, current settings, Switchboard connection status, backup status, detected `routingMode`, and the settings path.
- `POST /api/cli-tools/claude-settings` applies `env` values and removes managed keys listed in `removeEnvKeys`.
- `DELETE /api/cli-tools/claude-settings` disconnects Switchboard and restores the previous Claude Code settings when a backup is available. It does not remove model aliases.
- `GET|POST|DELETE /api/cli-tools/claude-full-catalog` reads, saves, or removes the isolated Full Catalog launch profile. Responses never return the stored Switchboard key.

Recommended pass-through example:

```bash
curl -X POST http://localhost:20128/api/cli-tools/claude-settings \
  -H 'Content-Type: application/json' \
  -d '{
    "env": {
      "ANTHROPIC_BASE_URL": "http://localhost:20128/v1",
      "ANTHROPIC_CUSTOM_HEADERS": "X-Switchboard-Key: sk_switchboard\nX-Switchboard-Claude-Mode: pass-through",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "openai/gpt-5.6",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "Switchboard · openai/gpt-5.6"
    },
    "removeEnvKeys": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_MODEL_OPTION", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]
  }'
```

Full Catalog profile example:

```bash
curl -X POST http://localhost:20128/api/cli-tools/claude-full-catalog \
  -H 'Content-Type: application/json' \
  -d '{
    "baseUrl": "http://localhost:20128/v1",
    "gatewayKey": "sk_switchboard",
    "models": ["cx/gpt-5.6-terra", "coding-auto"]
  }'

claude-switchboard
```

Discovered IDs are predictable: prepend `claude-switchboard-v1/` to the normal Switchboard model ID. This makes direct switching practical even when the catalog is large:

```text
/model claude-switchboard-v1/cx/gpt-5.6-terra
```

The same ID works at launch or in custom-agent frontmatter:

```bash
claude-switchboard --model claude-switchboard-v1/cx/gpt-5.6-terra
```

```yaml
model: claude-switchboard-v1/cx/gpt-5.6-terra
```

Legacy manually configured Claude-shaped aliases remain supported, but Full Catalog does not require them. It generates reversible Claude-compatible discovery IDs only for the selected Switchboard models and combos, then resolves those IDs back to their provider model or combo at request time.

## Generic Values

Most tools need these values:

```text
Base URL: http://localhost:20128/v1
API Key:  sk_switchboard
Model(s): one or more model IDs or combo names, depending on the client
```

Cursor is different: it may require a public URL because Cursor can route requests through its own service. Switchboard does not create that public URL for you.
