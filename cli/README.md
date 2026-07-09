# Switchboard CLI

Start and manage the Switchboard server (dashboard + OpenAI-compatible gateway) from the terminal. Optional system tray on macOS/Linux.

## Install (from this monorepo)

```bash
# From repo root
npm run cli:pack

# Or develop the CLI package
cd cli && npm run dev
```

Published package name: **`switchboard-router`** (npm). CLI command: **`switchboard`**.

> Bare name `switchboard` is already taken on npm by an unrelated package — always install **`switchboard-router`**.

```bash
npm i -g switchboard-router
switchboard
```

## What it does

- Launches the Next.js dashboard/gateway
- Stores runtime data under `~/.switchboard` (or `%APPDATA%/switchboard` on Windows)
- Optional tray icon and autostart helpers

Default port: **20128**

## Related docs

- Product direction: [../SWITCHBOARD.md](../SWITCHBOARD.md)
- Auto + Learn design: [../docs/switchboard/README.md](../docs/switchboard/README.md)
- Docker: [../DOCKER.md](../DOCKER.md)
