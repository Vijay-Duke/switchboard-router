# Media

Media providers are separate from chat-model providers and agent Skills. Open **Media** to configure providers by service type.

## Service Types

| Area | OpenAI-Compatible Route |
|---|---|
| Text to image | `/v1/images/generations` |
| Text to speech | `/v1/audio/speech` |
| Speech to text | `/v1/audio/transcriptions` |
| Embeddings | `/v1/embeddings` |
| Search | `/v1/search` |
| Web fetch | `/v1/fetch` |

Provider support varies. The dashboard shows only the media kinds and models registered for each provider, including compatible or custom providers where supported.

## Configure A Provider

1. Open **Media** and choose a service type.
2. Add or select a provider connection.
3. Test the connection with the service-specific probe.
4. Use a returned model ID with the matching endpoint.

Do not send a media model to `/v1/chat/completions` unless its provider explicitly exposes that model as chat-capable too.
