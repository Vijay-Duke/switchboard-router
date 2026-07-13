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

PKG_NAME="switchboard-router"

installed_version() {
  local package_json
  package_json="$(npm root -g)/$PKG_NAME/package.json"
  if [[ ! -f "$package_json" ]]; then
    printf 'not installed\n'
    return
  fi
  node -e 'console.log(require(process.argv[1]).version)' "$package_json"
}

LATEST_VERSION="$(npm view "$PKG_NAME@latest" version --prefer-online)"
if [[ -z "$LATEST_VERSION" ]]; then
  echo "Could not determine the latest $PKG_NAME version from npm." >&2
  exit 1
fi

CURRENT_VERSION="$(installed_version)"
echo "→ Installing $PKG_NAME $LATEST_VERSION (currently: $CURRENT_VERSION)…"
npm i -g "$PKG_NAME@$LATEST_VERSION" --prefer-online --no-audit --no-fund

INSTALLED_VERSION="$(installed_version)"
if [[ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]]; then
  echo "Installation verification failed: expected $LATEST_VERSION, found $INSTALLED_VERSION." >&2
  echo "npm global prefix: $(npm prefix -g)" >&2
  exit 1
fi

GLOBAL_PREFIX="$(npm prefix -g)"
EXPECTED_COMMAND="$GLOBAL_PREFIX/bin/switchboard"
RESOLVED_COMMAND="$(command -v switchboard || true)"
if [[ -z "$RESOLVED_COMMAND" ]]; then
  echo "Installed $PKG_NAME $INSTALLED_VERSION, but the switchboard command is not on PATH." >&2
  echo "Add $GLOBAL_PREFIX/bin to PATH and run: hash -r" >&2
  exit 1
fi
if [[ "$RESOLVED_COMMAND" != "$EXPECTED_COMMAND" ]]; then
  echo "The switchboard command resolves to an older or different installation." >&2
  echo "Expected: $EXPECTED_COMMAND" >&2
  echo "Found:    $RESOLVED_COMMAND" >&2
  echo "Put $GLOBAL_PREFIX/bin first on PATH and run: hash -r" >&2
  exit 1
fi

echo ""
echo "✓ Installed $PKG_NAME $INSTALLED_VERSION. The server is NOT running yet — start it with:"
echo "    switchboard"
echo ""
echo "Once started, it serves (check the startup banner — the port shifts if 20128 is busy):"
echo "  Dashboard: http://localhost:20128/dashboard"
echo "  API:       http://localhost:20128/v1"
