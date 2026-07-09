# Switchboard

**Intelligent model routing** — one OpenAI-compatible endpoint, multi-provider accounts, combos, and a local dashboard.

![Switchboard](./images/switchboard.png)

> Screenshot asset may still reflect an older theme; the live UI uses the **Crossbar Signal** identity (cool slate + teal).

## Why Switchboard?

You use many models and providers. Manually picking the right one every turn is slow; opaque “auto” modes hide the decision.

**Switchboard:**

- Exposes a single `/v1` endpoint for coding agents and SDKs
- Routes across providers and **model combos** (fallback, round-robin, fusion, and Auto)
- Tracks usage, quota, and health in a local dashboard
- Is designed to **self-improve** routing via logged outcomes (see [docs/switchboard](docs/switchboard/README.md))

```
CLI / IDE  →  Switchboard (/v1)  →  Provider or Combo worker
                 │
                 └── Dashboard: keys, combos, usage, routing insights
```

## Quick start

```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

- Dashboard: `http://localhost:20128/dashboard`
- API: `http://localhost:20128/v1`

Production:

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
```

CLI launcher (optional):

```bash
npm run cli:pack
# or from cli/: npm run dev
```

Data defaults to `~/.switchboard` (override with `DATA_DIR`).

## Key features

| Area | Capability |
|------|------------|
| Gateway | OpenAI-compatible `/v1/*`, format translation, streaming |
| Providers | OAuth + API key accounts, multi-account fallback |
| Combos | Fallback, round robin, fusion — Auto strategy (router → worker) in progress |
| Ops | Usage logs, quota tracking, token saver, proxy pools |
| Surface | Web dashboard, optional CLI tray launcher |

Product roadmap for **Auto + Learn**: [SWITCHBOARD.md](./SWITCHBOARD.md) and [docs/switchboard/PHASES.md](docs/switchboard/PHASES.md).

## Point a client at Switchboard

Use your dashboard API key and base URL:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:20128/v1"
export OPENAI_API_KEY="sk_switchboard"   # or key from Endpoint & Key
```

Works with Claude Code, Codex, Cline, Cursor, Continue, and any OpenAI-compatible client.

## Configuration

See [`.env.example`](./.env.example) for the full contract. Highlights:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATA_DIR` | `~/.switchboard` | SQLite and app state |
| `JWT_SECRET` | auto | Dashboard session signing |
| `INITIAL_PASSWORD` | `123456` | **Change this** |
| `PORT` | `20128` | HTTP port |

Docker notes: [DOCKER.md](./DOCKER.md).

## Development

```bash
# Lint
npx eslint .

# Tests (independent package under tests/)
npm install && cd tests && npm install
npx vitest run
```

Architecture overview: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)  
Agent conventions for the routing engine: [open-sse/AGENTS.md](open-sse/AGENTS.md)

## License

See [LICENSE](./LICENSE).
