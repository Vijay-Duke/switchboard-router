# Providers

Providers are the accounts or API keys Switchboard can send requests to.

## Provider Types

Switchboard supports several provider styles:

- OAuth providers, such as Claude, Codex, Cursor, Gemini CLI, GitHub, iFlow, Kiro, Qwen, and others.
- API key providers, such as OpenAI, Anthropic, OpenRouter, Gemini, DeepSeek, Groq, Mistral, Perplexity, xAI, and others.
- Local or self-hosted providers, such as Ollama-compatible endpoints.
- Media providers for embeddings, images, speech, search, and fetch where the provider supports those services.

The exact list comes from the app registry and may change between releases. Use the **Providers** page in the dashboard as the source of truth.

## Add A Provider

1. Open **Providers**.
2. Pick a provider.
3. Use OAuth, an API key, or the provider-specific setup shown in the form.
4. Test the connection.

Connected providers make their models available through `/v1/models`.

## Custom Providers

Switchboard includes OpenAI-compatible and Anthropic-compatible provider entries. Use these when a service speaks one of those APIs but is not listed directly.

## Reasoning And Thinking

Clients ask for thinking in different shapes: Claude's `thinking`, OpenAI's `reasoning_effort`, Gemini's `thinkingConfig`. Switchboard translates whatever the client sends into the spelling the target model's gateway actually accepts, instead of guessing from the model name. Models that support no reasoning control get the thinking parameters stripped, so the request still succeeds.

For custom OpenAI-compatible providers, the accepted spelling is captured per model when you click **Import models** on the provider's page. Switchboard reads the gateway's own model listing and remembers, per model, whether it takes a flat `reasoning_effort` string, a nested `reasoning:{effort}` object, `enable_thinking` + `thinking_budget`, or nothing at all.

How the format is picked, in order:

1. The per-model descriptor captured at import, when the gateway exposes one.
2. A static default for the node's base URL host, for gateways without introspection.
3. A model-name pattern (the legacy guess).

Known gateways:

| Gateway | Reasoning control |
|---|---|
| Catalogs with `supported_parameters` (Surplus Intelligence, OpenRouter-style, Nous) | Flat `reasoning_effort` and/or nested `reasoning`, exactly as listed per model |
| ZENMux (`capabilities:{reasoning}`) | Flat `reasoning_effort`; Responses-API nodes get native `reasoning:{effort, summary}` |
| CrofAI (per-model `reasoning_effort` flag) | Flat `reasoning_effort` |
| DashScope compatible-mode, including `aliyuncs.com` hosts | `enable_thinking` + `thinking_budget` |
| opencode Zen / Go (`opencode.ai`) | Flat `reasoning_effort` only; thinking objects are rejected there |
| Nous Hermes (`inference-api.nousresearch.com`) | None in the request body; reasoning is toggled by system prompt, so thinking parameters are stripped |
| Any other host | Flat `reasoning_effort`, the most portable spelling |

Models imported before this change keep the old behavior until you re-click **Import models** on the provider's page.

## Peak Hours

Some providers bill by time of day. DeepSeek, for example, charges about half price outside its peak windows. A provider's page has an optional **Peak hours** card for this:

- Off by default. Routing does not change until you configure it.
- Pick an IANA timezone for the schedule; window times follow that zone. Default is UTC.
- Add one or more windows: type (peak or off-peak), start and end times, and days of the week. Time outside every window uses the default state you choose.
- Presets can seed the editor, including "DeepSeek (current)" and the earlier Feb 2025 off-peak shape. The stored windows stay your own config.
- A live badge shows peak or off-peak right now, with a countdown to the next change.

For custom OpenAI-compatible and Anthropic-compatible providers, the schedule is keyed by the prefix the node's models use, not its internal id.

Scheduled providers also expose their current state in `/v1/models/info?id=...` as a `schedule` object (`status`, `nextChange`, `timezone`, `defaultState`, `windows`).

## Model Prefixes

Model IDs usually include a provider prefix:

```text
openai/gpt-...
anthropic/claude-...
cc/...
cx/...
openrouter/...
```

Do not guess model names from old docs. Pick models from the dashboard or call `/v1/models`.
