# CLAUDE.md

Guidance for coding agents working in this repository.

## What this is

**Switchboard** (`switchboard-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across many upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Product direction (Auto strategy + learning): [SWITCHBOARD.md](./SWITCHBOARD.md) and [docs/switchboard/](docs/switchboard/).

Two packages live in this repo:
- The **dashboard + gateway** (root `package.json`, `switchboard-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, package name `switchboard`) — installs/starts the server and manages the tray.

Code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (provider-agnostic routing/translation engine), `cli/` (launcher), and `tests/`.

## Brand

- Product name: **Switchboard** (never use legacy product names in UI, docs, or user-facing strings).
- Data directory default: `~/.switchboard` (Windows: `%APPDATA%/switchboard`).
- Default demo key string in docs: `sk_switchboard`.
- Visual identity: cool slate + teal “Crossbar Signal” tokens in `src/app/globals.css`.

## Commands

Dashboard/gateway (repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .`

CLI package (`cli/`):
```bash
npm run cli:pack
cd cli && npm run dev
```

Tests (vitest, under `tests/` — independent ESM package):
```bash
npm install
cd tests && npm install
npx vitest run
npx vitest run unit/capabilities.test.js
```
> Prefer `npx vitest` over the committed Unix-hardcoded `tests/package.json` `test` script.
>
> The suite is **not** expected all-green on a plain checkout. Use `tests/__baseline__/verify-no-regression.mjs` for regression judgment.

## Architecture

- `docs/ARCHITECTURE.md` — full system lifecycle
- `open-sse/AGENTS.md` — routing/translation engine conventions

### Request flow
`src/app/api/v1/*` → `src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` → executors + translators → SSE back to client.

`src/sse/` is app-side glue; `open-sse/` is the provider-agnostic engine.

### Persistence
SQLite under `src/lib/db/` with adapter fallback (`bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js`).  
`src/lib/localDb.js` is a compat shim. Prefer `@/lib/db/index.js`.  
DB path via `src/lib/db/paths.js` / `DATA_DIR` else `~/.switchboard`.

### RTK token saver (`open-sse/rtk/`)
Fail-open compression of `tool_result` content. Never throw out of hooks.

## Conventions

- Plain JavaScript (ESM), no TypeScript. `@/*` → `src/*`.
- Conventional Commits (`fix(translator): …`, `feat(...)`).
- Security-sensitive env: `JWT_SECRET`, `INITIAL_PASSWORD`, `API_KEY_SECRET`, `MACHINE_ID_SALT` — see `.env.example`.

### Dashboard data & typing

- **Server Components own initial reads.** Use loaders in `src/lib/dashboard/loaders.js` (call DB repos directly — no `fetch("/api/...")` on the server).
- **Client components** are for interaction only. Prefer `initialData` from the server + **TanStack Query** (`@tanstack/react-query`) for cache/refetch/mutations (`src/shared/query/`).
- Add `// @ts-check` + JSDoc on files under `src/app/**` (and loaders/query helpers) so the IDE surfaces type errors without a TS migration.
