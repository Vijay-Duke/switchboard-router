# Installation

Switchboard requires Node.js 18 or newer and npm.

## Install Script

The recommended installer downloads the latest packaged release:

```bash
curl -fsSL https://raw.githubusercontent.com/Vijay-Duke/switchboard-router/master/install.sh | bash
switchboard
```

## npm

The published package is `switchboard-router`; the command is `switchboard`. The bare npm package named `switchboard` is unrelated.

```bash
npm i -g switchboard-router
switchboard
```

You can also install the package attached to the latest GitHub release:

```bash
npm i -g https://github.com/Vijay-Duke/switchboard-router/releases/latest/download/switchboard-router.tgz
switchboard
```

## Manage The Local Process

```bash
switchboard status
switchboard stop
switchboard restart
switchboard --help
```

`Ctrl+C` and the tray menu’s **Quit** action shut the app down gracefully. If the tray is unavailable, use `switchboard stop`.

## Update

```bash
npm i -g switchboard-router@latest --prefer-online
```

The dashboard also shows an update badge when a newer packaged version is available. Updating does not remove data under `~/.switchboard`.

## From Source

```bash
git clone https://github.com/Vijay-Duke/switchboard-router.git
cd switchboard-router
npm install
npm run build
PORT=20128 npm run start
```

For development:

```bash
PORT=20128 npm run dev
```

## Data Directory

Switchboard stores its database, credentials, and runtime state under:

```text
~/.switchboard
```

Set `DATA_DIR` before launch to use another location:

```bash
DATA_DIR=/path/to/switchboard-data switchboard
```

## Uninstall

```bash
npm rm -g switchboard-router
```

The data directory is retained. Remove `~/.switchboard` separately only if you also want to delete provider connections, API keys, usage history, and settings.

## URLs

```text
Dashboard: http://127.0.0.1:20128/dashboard
API:       http://127.0.0.1:20128/v1
```
