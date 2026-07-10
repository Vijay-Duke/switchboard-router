# CLI Tools

The dashboard has a **CLI Tools** page for configuring supported tools on your machine.

## Supported From The App

The current app includes helpers or guides for Claude Code, Codex, Cursor, Cline, Roo, Continue, OpenCode, Open Claw, Aider, Gemini CLI, Qwen Code, Kilo Code, DeepSeek TUI, jcode, Grok CLI, Pi, Amp CLI, Factory Droid, Hermes Agent, and Claude Cowork.

It also includes MITM setup pages for Antigravity, GitHub Copilot, and Kiro.

## Use The Dashboard First

Open:

```text
http://localhost:20128/dashboard/cli-tools
```

Pick a tool and follow the generated setup. The dashboard can use your current API key, base URL, and selected model instead of hard-coded examples.

## Generic Values

Most tools need these values:

```text
Base URL: http://localhost:20128/v1
API Key:  sk-...
Model:    a model ID or combo name
```

Cursor is different: it may require a public URL because Cursor can route requests through its own service. Switchboard does not create that public URL for you.
