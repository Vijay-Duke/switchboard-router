# Switchboard

**One local endpoint for every AI model you use.**

Point Claude Code, Cursor, Codex, Cline, or any OpenAI-compatible client at Switchboard. It routes across your provider accounts and combos — including **Auto**, which picks the right model and gets better over time.

<p align="center">
  <img src="images/console-overview.png" alt="Switchboard dashboard" width="900" />
</p>

<p align="center">
  <a href="https://github.com/Vijay-Duke/switchboard-router/releases/latest"><img src="https://img.shields.io/github/v/release/Vijay-Duke/switchboard-router?style=flat-square&label=latest" alt="Latest release" /></a>
  <a href="https://www.npmjs.com/package/switchboard-router"><img src="https://img.shields.io/npm/v/switchboard-router?style=flat-square" alt="npm" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" alt="Node 18+" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" />
</p>

---

## Install

**Requires [Node.js 18+](https://nodejs.org/).** Copy → paste → run:

```bash
npm i -g https://github.com/Vijay-Duke/switchboard-router/releases/latest/download/switchboard-router.tgz && switchboard
```

Dashboard: **http://localhost:20128/dashboard** · API: **http://localhost:20128/v1**

```bash
# After the package is on npm (same result, shorter):
npm i -g switchboard-router && switchboard
```

> Always install **`switchboard-router`**. The bare name `switchboard` on npm is a different project.

---

## Use it in 30 seconds

1. Open **http://localhost:20128/dashboard**
2. Connect a provider (OAuth or API key)
3. Copy your endpoint + key from **Endpoint & keys**
4. Point your coding agent at Switchboard:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:20128/v1"
export OPENAI_API_KEY="sk-…"   # from the dashboard
```

Or use **CLI tools** in the dashboard to wire Claude Code, Cursor, Codex, Cline, Continue, and others automatically.

---

## What you get

| | |
|---|---|
| **One gateway** | OpenAI-compatible `/v1` — works with almost every agent and SDK |
| **Many providers** | Claude, Codex, Cursor, Gemini, free tiers, API keys, and more |
| **Combos** | Fallback, round-robin, fusion, or **Auto** (router → best worker) |
| **Learning** | Auto records outcomes and improves which model wins per task type |
| **Local-first** | Runs on your machine; data in `~/.switchboard` |

<p align="center">
  <img src="images/switchboard.png" alt="Providers" width="880" />
</p>

---

## Docker

```bash
docker run -d \
  --name switchboard \
  -p 20128:20128 \
  -v "$HOME/.switchboard:/app/data" \
  -e DATA_DIR=/app/data \
  ghcr.io/vijay-duke/switchboard-router:latest
```

Then open **http://localhost:20128/dashboard**.

---

## Docs & help

- [User docs](https://vijay-duke.github.io/switchboard-router/)
- [Releases](https://github.com/Vijay-Duke/switchboard-router/releases)
- [Architecture](docs/ARCHITECTURE.md) · [Auto / Learn specs](docs/switchboard/README.md)

---

## License

MIT
