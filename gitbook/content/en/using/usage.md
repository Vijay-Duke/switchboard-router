# Usage & Quota

Switchboard records usage for requests that pass through its endpoint.

## Usage Pages

The dashboard includes:

- **Overview** for recent requests and token totals.
- **Usage** for history and charts.
- **Quota** for provider usage data where the provider exposes it.
- **Request details** when request logging is enabled.

## What Is Tracked

Switchboard stores request time, provider, model, endpoint, token counts, status, estimated cost, and related metadata when available.

Quota data depends on the provider. Some providers expose quota or reset information; others only return normal request results.

## Request Logs

Detailed request logging is controlled by configuration. Leave it off unless you need to debug because logs can contain prompt or response data.

```bash
ENABLE_REQUEST_LOGS=false
```

## Auto Ping

The app includes quota auto-ping support for providers that use sliding quota windows. It is meant to keep eligible windows warm when configured, not to bypass provider limits.
