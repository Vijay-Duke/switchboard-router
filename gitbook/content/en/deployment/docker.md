# Docker

Run Switchboard in a container when you want a repeatable local setup.

## Run

```bash
docker run -d \
  --name switchboard \
  -p 127.0.0.1:20128:20128 \
  -v "$HOME/.switchboard:/app/data" \
  -e DATA_DIR=/app/data \
  -e SWITCHBOARD_LOCAL_PEERS=172.30.0.1 \
  ghcr.io/vijay-duke/switchboard-router:latest
```

Open:

```text
http://localhost:20128/dashboard
```

## Why the two extra flags

Switchboard's dashboard and credential routes are restricted to *local* callers,
and locality is decided by the peer address of the TCP connection — not by any
header a client can set.

Under Docker's default bridge network your browser does not appear as
`127.0.0.1` inside the container. It appears as the bridge gateway, typically
`172.17.0.1`. Without help, the dashboard page loads and every one of its API
calls returns `403 Local only`.

The two flags fix that together, and only work as a pair:

- `-e SWITCHBOARD_LOCAL_PEERS=172.30.0.1` tells Switchboard to trust only the
  Docker bridge range as local. It is applied only to the socket-derived peer
  address, never to a header.
- `-p 127.0.0.1:20128:20128` publishes the port on the host's loopback
  interface only, so nothing outside your machine can reach the container and
  benefit from that allowlist.

Publishing on `0.0.0.0` **and** setting `SWITCHBOARD_LOCAL_PEERS` would hand
every LAN client full access to your provider credentials. If you need LAN
access to the gateway, publish broadly but leave `SWITCHBOARD_LOCAL_PEERS`
unset: `/v1` stays reachable with an API key, and the credential routes stay
closed.

Set `SWITCHBOARD_LOCAL_PEERS` to the gateway your network actually uses.
Compose projects usually allocate `172.18.x.x` or higher; check with:

```bash
docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

## Data

The bind mount keeps the database and runtime files on your machine:

```text
$HOME/.switchboard
```

Inside the container, the app reads:

```text
/app/data
```

## Manage

```bash
docker logs -f switchboard
docker stop switchboard
docker start switchboard
docker rm -f switchboard
```

## Headroom

The Switchboard image does not bundle Headroom. If you use Headroom, run it as a separate service and set `HEADROOM_URL` to that service.
