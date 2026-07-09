#!/usr/bin/env bash
# Install Switchboard CLI (latest release). Requires Node.js 18+.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org/" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required (ships with Node.js)." >&2
  exit 1
fi

PKG_URL="https://github.com/Vijay-Duke/switchboard-router/releases/latest/download/switchboard-router.tgz"

echo "→ Installing switchboard-router (latest)…"
npm i -g "$PKG_URL"

echo ""
echo "✓ Installed. Start with:"
echo "    switchboard"
echo ""
echo "Dashboard: http://localhost:20128/dashboard"
echo "API:       http://localhost:20128/v1"
