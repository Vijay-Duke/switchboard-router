# Local Deployment

Local is the normal way to run Switchboard.

## Run

```bash
switchboard
```

Open:

```text
http://localhost:20128/dashboard
```

Use:

```text
http://localhost:20128/v1
```

as the client base URL.

## Data Directory

Default:

```text
~/.switchboard
```

Custom:

```bash
DATA_DIR=/path/to/data switchboard
```

## Production-Like Local Run

Useful environment variables:

```bash
DATA_DIR=/var/lib/switchboard
PORT=20128
REQUIRE_API_KEY=true
```

## Access Control

Switchboard is a single-user local gateway. There is no dashboard login, no
password and no OIDC — the trust boundary is the network bind:

- **`HOSTNAME=127.0.0.1` (default).** Only processes on this machine can
  connect. The dashboard and every `/api/*` route are open to them.
- **`HOSTNAME=0.0.0.0`.** LAN clients can reach `/v1` with an API key
  (`REQUIRE_API_KEY=true`, the default). Dashboard and credential routes stay
  closed to them: an API key does **not** open those — only a local peer or the
  CLI token does. Start with `npm run start:standalone` so the server derives
  each caller's address from the TCP socket; a plain `next start` cannot, and
  therefore refuses local-only routes to everyone.
- **Containers.** A Docker bridge peer is not loopback. See the Docker guide for
  `SWITCHBOARD_LOCAL_PEERS`, which must be paired with a loopback-only publish.
- **Behind a reverse proxy.** Terminate TLS there and forward to `127.0.0.1`.
  Switchboard trusts `X-Forwarded-For` only from a loopback peer, and marks
  proxied requests as non-local so they can never reach credential routes
  without an API key.
