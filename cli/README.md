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

## Operations

```bash
switchboard                 # start with the interface menu
switchboard --tray          # start directly in tray mode
switchboard status          # show URL, versions, PID, start time, and ownership
switchboard stop            # gracefully stop the owned instance
switchboard restart         # gracefully stop, then start again
switchboard --help          # complete command and option reference
```

In an interactive terminal, `Ctrl+C` uses the same graceful shutdown path as
`switchboard stop`: the tray helper, gateway, MITM helper, and recorded child
processes are stopped before the launcher exits. In tray mode, choose **Quit**.
If the tray icon is missing, `switchboard stop` remains available.

Starting Switchboard again is safe. The launcher replaces a verified prior
Switchboard instance, including an orphaned bundled `next-server`, but refuses
to signal an unrelated process that happens to use the same port. Use
`switchboard status` for the listener PID and recovery guidance.

Common options:

| Option | Purpose |
|:--|:--|
| `-p, --port <port>` | Port from 1 to 65535 (default `20128`) |
| `-H, --host <host>` | Bind address (default `127.0.0.1`) |
| `-l, --log` | Stream server output while retaining crash diagnostics |
| `-t, --tray` | Start with the system-tray control surface |
| `--skip-update` | Skip the startup update check |
| `--json` | Machine-readable `status` output |

`--host 0.0.0.0` or `--host ::` is network-exposed and is called out explicitly
in the terminal. Auto-start is opt-in from the tray menu; simply hiding the app
to the tray does not enable start-on-boot.

Tray/autostart logs on macOS are `/tmp/switchboard.log` and
`/tmp/switchboard.error.log`. Runtime ownership state is stored under
`~/.switchboard/runtime/owned-processes.json` (or the configured `DATA_DIR`).

## Related docs

- Product direction: [../SWITCHBOARD.md](../SWITCHBOARD.md)
- Auto + Learn design: [../docs/switchboard/README.md](../docs/switchboard/README.md)
- Docker: [../DOCKER.md](../DOCKER.md)
