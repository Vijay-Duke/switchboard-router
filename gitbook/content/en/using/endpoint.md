# Endpoint & Keys

The dashboard shows the local base URL:

```text
http://localhost:20128/v1
```

Use this URL anywhere a client asks for an OpenAI-compatible base URL.

## API Keys

Open **Endpoint & Keys** to create, pause, resume, or delete keys.

When **Require API key** is on, `/v1` requests must include:

```text
Authorization: Bearer sk-...
```

New keys are shown once. Store the key before closing the dialog.

## Local Only

Switchboard is local-only by default. The current app does not provide a built-in public cloud endpoint or tunnel. If you bind it to a non-loopback address or put it behind your own proxy, keep API keys required.

## Common Environment Variables

```bash
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_API_KEY="sk-..."
```

Some clients use different names, but the values are the same: base URL plus API key.
