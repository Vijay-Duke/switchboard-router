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
