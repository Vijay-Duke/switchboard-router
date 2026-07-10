# Installation

## Requirements

- Node.js 18 or newer
- npm
- A browser for the dashboard

## Recommended Install

```bash
curl -fsSL https://raw.githubusercontent.com/Vijay-Duke/switchboard-router/master/install.sh | bash
switchboard
```

## Release Package

```bash
npm i -g https://github.com/Vijay-Duke/switchboard-router/releases/latest/download/switchboard-router.tgz
switchboard
```

The package name is `switchboard-router`. The command is `switchboard`.

## From Source

```bash
git clone https://github.com/Vijay-Duke/switchboard-router.git
cd switchboard-router
npm install
npm run build
npm run start
```

For development:

```bash
npm run dev
```

## Data

By default, Switchboard stores data in:

```text
~/.switchboard
```

Use `DATA_DIR` to choose another folder:

```bash
DATA_DIR=/path/to/switchboard-data switchboard
```

## URLs

```text
Dashboard: http://localhost:20128/dashboard
API:       http://localhost:20128/v1
```
