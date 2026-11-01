# Endpoint & Keys

The dashboard shows the local base URL:

```text
http://localhost:20128/v1
```

Use this URL anywhere a client asks for an OpenAI-compatible base URL.

## Discover Thinking Efforts

Harnesses can read `GET /v1/models` and inspect each model's
`capabilities.effort`. For example, a DeepSeek V4 model can advertise:

```json
{
  "effort": {
    "supported": true,
    "high": { "supported": true },
    "max": { "supported": true }
  }
}
```

Offer levels whose `supported` value is `true`, then send the selected level
as `reasoning_effort` in chat requests. These are Switchboard selections;
the gateway translates them into the upstream model's wire format. Missing
metadata means support is unknown, not that reasoning is disabled.

This capability object extends the OpenAI model-list response, so clients
must explicitly consume it. Switchboard's generated Pi configuration uses
`thinkingLevelMap` (including an explicit `max` entry); omp uses
`thinking.efforts`. FX exposes effort choices as model IDs such as
`command-code/deepseek/deepseek-v4.1-flash(max)`.

## API Keys

Open **Endpoint & Keys** to create, pause, resume, or delete keys.

When **Require API key** is on, `/v1` requests must include:

```text
Authorization: Bearer sk_switchboard
```

New keys are shown once. Store the key before closing the dialog.

## Local Only

Switchboard is local-only by default. The current app does not provide a built-in public cloud endpoint or tunnel. If you bind it to a non-loopback address or put it behind your own proxy, keep API keys required.

## Common Environment Variables

```bash
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_API_KEY="sk_switchboard"
```

Some clients use different names, but the values are the same: base URL plus API key.
