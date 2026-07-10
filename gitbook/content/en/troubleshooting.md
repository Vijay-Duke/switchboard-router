# Troubleshooting

## Cannot Connect To Switchboard

Check that the app is running:

```bash
curl http://localhost:20128/api/health
```

Then open:

```text
http://localhost:20128/dashboard
```

If the port is already in use, stop the other process or run Switchboard with a different `PORT`.

## 401 Unauthorized

Your client did not send a valid key.

1. Open **Endpoint & Keys**.
2. Create or copy an active key.
3. Send `Authorization: Bearer sk-...`.

If you intentionally disabled **Require API key**, remember that only local clients should be able to reach the service.

## Model Not Found

Use the dashboard model picker or call:

```bash
curl http://localhost:20128/v1/models \
  -H "Authorization: Bearer sk-..."
```

If a provider was just added, test the provider connection and refresh the model list.

## Provider Fails Or Returns Empty Output

Common causes:

- The provider account is not connected.
- The provider token expired.
- The model is disabled or unavailable.
- The request uses a capability the model does not support.

Try reconnecting the provider, testing a simpler model, or routing through a fallback combo.

## OAuth Token Expired

Open **Providers**, reconnect the provider, and complete the OAuth flow again. If the provider keeps failing, check whether the upstream service is available.

## Requests Are Going To The Wrong Model

Check whether the client is using:

- A raw model ID.
- A model alias.
- A combo name.

For combos, open **Combos** and confirm the strategy and model order.

## Cursor Cannot Use Localhost

Some Cursor setups do not call local endpoints directly. Use the **CLI Tools** Cursor guide. If you expose Switchboard through your own public URL, keep API keys required and use HTTPS.

## Need More Detail

Use **Usage**, **Console Log**, and request logs when debugging. Enable detailed request logs only while investigating because they can contain prompt and response data.
