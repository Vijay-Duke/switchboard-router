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
| `-H, --host <host>` | Bind address (default `0.0.0.0` — remote dashboard access; non-local browsers sign in with a gateway API key, non-loopback `/v1` requires an API key. Use `127.0.0.1` for local-only) |
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

## Connect local tools to a gateway

`connect` configures tools on this machine without starting a local server:

```bash
switchboard connect https://gateway.example --tools claude,codex --model provider/model
switchboard connect --tools pi --model provider/model
switchboard show claude codex pi --json
switchboard connect --reset --tools claude,codex,pi
```

Remote connections prompt for a dashboard API key; automated runs can use
`SWITCHBOARD_CONNECT_KEY`. Each connection creates a fresh client key. Existing
saved key secrets are never fetched. Local connections use the local gateway's
machine token to create the key. Tool files use the dashboard's existing writers,
backups and reset behavior. `show` reads local configuration and masks secrets.

Use `--save` with a remote URL to remember its dashboard session in an origin-bound,
owner-only `connect-session.json` in the Switchboard data directory. This file
contains a session cookie, not the sign-in or client API key. Use `--print-env`
only when you intend to print the new client key for another application.

`--list-tools` lists supported tools. Claude tier flags (`--opus`, `--sonnet`,
`--fable`, `--haiku`) override individual models; `--model` supplies every tier.
Use `--codex-profile work=provider/model` alongside `--tools codex` to create a
local profile, and `show --profiles` to inspect profiles. Failed connections
revoke the new key if it was neither configured nor explicitly printed.
