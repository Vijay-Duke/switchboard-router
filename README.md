# Switchboard

**Local AI routing gateway** — one OpenAI-compatible endpoint, multi-provider accounts, model combos (including **Auto**), and a dashboard for ops and learning.

<p align="center">
  <img src="images/console-overview.png" alt="Switchboard dashboard — Overview" width="900" />
</p>

<p align="center">
  <a href="https://github.com/Vijay-Duke/switchboard-router/releases/latest"><img src="https://img.shields.io/github/v/release/Vijay-Duke/switchboard-router?label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node >= 18" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
</p>

```
Your CLI / IDE  →  Switchboard (:20128/v1)  →  Provider accounts & combos
                         │
                         └── Dashboard: providers, keys, combos, usage, Auto insights
```

---

## Why Switchboard?

You juggle many models and providers. Hand-picking every turn is slow; closed “auto” modes hide the decision.

**Switchboard** sits on your machine and:

- Exposes a single **`/v1`** API for coding agents and SDKs  
- Routes across OAuth + API-key providers and **combos** (fallback, round-robin, fusion, **Auto**)  
- Logs outcomes so **Auto** can learn which workers win per task cluster  
- Gives you a **local dashboard** — no required cloud control plane  

---

## Install

### From GitHub Release (recommended)

Download the CLI package from the [latest release](https://github.com/Vijay-Duke/switchboard-router/releases/latest), then:

```bash
npm i -g ./switchboard-router-0.5.20.tgz   # use the version you downloaded
switchboard
```

- **Dashboard:** http://localhost:20128/dashboard  
- **API:** http://localhost:20128/v1  
- **Data:** `~/.switchboard` (legacy `~/.9router` is still detected if present)

> **npm name:** install package **`switchboard-router`** · **CLI command:** **`switchboard`**  
> Bare name `switchboard` on npm is an unrelated package — do not install that.

### From source

```bash
git clone https://github.com/Vijay-Duke/switchboard-router.git
cd switchboard-router
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

Production:

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
```

CLI launcher from this monorepo:

```bash
npm run cli:pack          # builds cli/ and packs switchboard-router-*.tgz
cd cli && npm run dev     # or run the packed CLI
```

---

## Point a client at Switchboard

In the dashboard: **Endpoint & keys** → copy base URL and API key.

```bash
export OPENAI_BASE_URL="http://127.0.0.1:20128/v1"
export OPENAI_API_KEY="sk_…"   # from the dashboard
```

Works with **Claude Code**, **Codex**, **Cursor**, **Cline**, **Continue**, **Grok**, **Pi**, **Aider**, **Gemini CLI**, and any OpenAI-compatible client. Use **CLI tools** in the dashboard to write settings for common agents.

---

## Features

| Area | What you get |
|------|----------------|
| **Gateway** | OpenAI-compatible `/v1/*`, format translation, streaming, multi-account fallback |
| **Providers** | OAuth (Claude, Codex, Cursor, Antigravity, …) + API keys + free tiers |
| **Combos** | Fallback, round-robin, fusion, **Auto** (router model → worker pool) |
| **Learning** | Routing events, bandit artifacts, Relearn / scheduled learn, insights UI |
| **Ops** | Usage & quota, token saver, MITM helpers, local SQLite |
| **Security** | Local-first; admin `/api/*` gated to loopback / CLI token |

### Auto routing

Create a combo with strategy **Auto**:

1. Pick a **router** model (e.g. a strong Claude)  
2. Build a **worker pool** (cheap + strong models)  
3. Point clients at the combo name as the model  
4. Open **Combos → Insights** to see decisions, scores, and relearn  

Design notes: [docs/switchboard/](docs/switchboard/README.md) · product direction: [SWITCHBOARD.md](./SWITCHBOARD.md)

---

## Screenshots

<p align="center">
  <img src="images/console-overview.png" alt="Overview — traffic and system health" width="880" />
  <br />
  <em>Overview — live traffic, providers, endpoint</em>
</p>

<p align="center">
  <img src="images/switchboard.png" alt="Providers catalog" width="880" />
  <br />
  <em>Providers — OAuth, free tier, and API-key connections</em>
</p>

---

## Configuration

See [`.env.example`](./.env.example). Common settings:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATA_DIR` | `~/.switchboard` | SQLite + app state |
| `PORT` | `20128` | HTTP port |
| `HOSTNAME` | `0.0.0.0` | Bind address (use `127.0.0.1` for local-only) |
| `INITIAL_PASSWORD` | `123456` | Override if you enable password flows |

Docker: [DOCKER.md](./DOCKER.md)

---

## Development

```bash
# App
npm install
npm run dev

# Lint
npx eslint .

# Tests (separate package under tests/)
npm install && cd tests && npm install
npx vitest run unit/switchboard-auto.test.js
```

| Doc | Contents |
|-----|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Request lifecycle, OAuth, persistence |
| [docs/switchboard/](docs/switchboard/README.md) | Auto + Learn product/engineering specs |
| [cli/README.md](cli/README.md) | CLI package notes |

---

## Releases

- **Source + tags:** https://github.com/Vijay-Duke/switchboard-router  
- **Downloads:** https://github.com/Vijay-Duke/switchboard-router/releases  

Install from a release asset:

```bash
npm i -g ./switchboard-router-0.5.20.tgz
switchboard
```

---

## License

MIT — see [cli/LICENSE](cli/LICENSE) and repository license files.
