# Docker

Run Switchboard in a container. Build the image locally from this repo (multi-platform `linux/amd64` + `linux/arm64` when you set the build platforms).

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 127.0.0.1:20128:20128 \
  -v "$HOME/.switchboard:/app/data" \
  -e DATA_DIR=/app/data \
  -e SWITCHBOARD_LOCAL_PEERS=172.30.0.1 \
  --name switchboard \
  switchboard:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Why the two extra flags

The dashboard and all credential routes are restricted to *local* callers, and
locality comes from the peer address of the TCP connection — never from a header.

Under Docker's default bridge network your browser does not appear as
`127.0.0.1` inside the container; it appears as the bridge gateway (typically
`172.17.0.1`). Without help the dashboard page loads and every one of its API
calls returns `403 Local only`.

The flags only work as a pair:

- `-e SWITCHBOARD_LOCAL_PEERS=172.30.0.1` trusts only the configured Compose bridge gateway,
  applied only to the socket-derived peer address.
- `-p 127.0.0.1:20128:20128` publishes on the host's loopback interface only, so
  nothing off-machine can reach the container and benefit from that trust.

Publishing on `0.0.0.0` **and** setting `SWITCHBOARD_LOCAL_PEERS` exposes your
provider credentials to the whole LAN. To serve the gateway to the LAN, publish
broadly and leave `SWITCHBOARD_LOCAL_PEERS` unset: `/v1` stays reachable with an
API key, and the credential routes stay closed.

Confirm the gateway your network actually uses:

```bash
docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

## Manage container

```bash
docker logs -f switchboard        # view logs
docker stop switchboard           # stop
docker start switchboard          # start again
docker rm -f switchboard          # remove
```

## Data persistence

```bash
-v "$HOME/.switchboard:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.switchboard/` (macOS/Linux) or `%APPDATA%\switchboard\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.switchboard/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 127.0.0.1:20128:20128 \
  -v "$HOME/.switchboard:/app/data" \
  -e DATA_DIR=/app/data \
  -e SWITCHBOARD_LOCAL_PEERS=172.30.0.1 \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name switchboard \
  switchboard:latest
```

### LAN mode (gateway only, no dashboard)

To serve `/v1` to other machines, publish broadly and leave
`SWITCHBOARD_LOCAL_PEERS` **unset**. LAN clients then need an API key, and the
dashboard's credential routes stay closed to them — including to you, so manage
the instance from the host with the CLI:

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.switchboard:/app/data" \
  -e DATA_DIR=/app/data \
  --name switchboard \
  switchboard:latest
```

## Optional Headroom sidecar

The Switchboard image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point Switchboard at that proxy:

```yaml
services:
  switchboard:
    image: switchboard:latest
    ports:
      # Loopback publish + bridge allowlist: keep these two together.
      - "127.0.0.1:20128:20128"
    volumes:
      - "$HOME/.switchboard:/app/data"
    environment:
      DATA_DIR: /app/data
      SWITCHBOARD_LOCAL_PEERS: 172.30.0.1
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "127.0.0.1:8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
docker pull switchboard:latest
docker rm -f switchboard
# re-run the quick start command
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
cd app && docker build -t switchboard .

docker run --rm -p 127.0.0.1:20128:20128 \
  -v "$HOME/.switchboard:/app/data" \
  -e DATA_DIR=/app/data \
  -e SWITCHBOARD_LOCAL_PEERS=172.30.0.1 \
  switchboard
```

## Publish (automatic via CI)

Push a new, immutable git tag matching `v*`. GitHub Actions builds a
multi-platform image (amd64+arm64) and publishes these GHCR tags:

- `ghcr.io/vijay-duke/switchboard-router:{version}`
- `ghcr.io/vijay-duke/switchboard-router:{major}.{minor}`
- `ghcr.io/vijay-duke/switchboard-router:latest`

```bash
git tag -a v0.5.22 -m "Release v0.5.22"
git push origin v0.5.22
```

Never move or delete a published version tag. Fix a published release by
incrementing the patch version and creating a new tag.

Workflow: `.github/workflows/release.yml`
