---
name: switchboard-chat
description: Chat / code generation via Switchboard using OpenAI /v1/chat/completions, Anthropic /v1/messages, or /v1/responses — with streaming, tools, and combo strategies (fallback / Auto). Use when the user wants to ask an LLM, generate code, run agent tools, or route prompts through Switchboard.
---

# Switchboard — Chat

Requires `SWITCHBOARD_URL` (and `SWITCHBOARD_KEY` if auth enabled). See `$SWITCHBOARD_URL/api/skills/switchboard` for setup.

## Endpoints

| Endpoint | Format |
|----------|--------|
| `POST $SWITCHBOARD_URL/v1/chat/completions` | OpenAI Chat Completions |
| `POST $SWITCHBOARD_URL/v1/messages` | Anthropic Messages |
| `POST $SWITCHBOARD_URL/v1/responses` | OpenAI Responses API |

## Discover models

```bash
curl $SWITCHBOARD_URL/v1/models | jq '.data[] | {id, owned_by}'
curl "$SWITCHBOARD_URL/v1/models/info?id=openai/gpt-4o"
```

- Single models: `provider/model-id` (e.g. `openai/gpt-4o`, `cc/claude-sonnet-4-6`)
- **Combos**: dashboard name as `model` (e.g. `auto`) — Switchboard applies fallback / round-robin / fusion / Auto

## Prefer a combo for reliability

If the user has an Auto or fallback combo, use that name as `model` so Switchboard routes (and learns, for Auto):

```bash
curl -X POST $SWITCHBOARD_URL/v1/chat/completions \
  -H "Authorization: Bearer $SWITCHBOARD_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hi"}],"stream":false}'
```

## OpenAI format

```bash
curl -X POST $SWITCHBOARD_URL/v1/chat/completions \
  -H "Authorization: Bearer $SWITCHBOARD_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"Hi"}],"stream":false}'
```

JS (OpenAI SDK):

```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: `${process.env.SWITCHBOARD_URL}/v1`,
  apiKey: process.env.SWITCHBOARD_KEY,
});
const res = await client.chat.completions.create({
  model: "auto", // or "openai/gpt-4o"
  messages: [{ role: "user", content: "Hi" }],
  stream: true,
});
for await (const chunk of res) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## Anthropic format

```bash
curl -X POST $SWITCHBOARD_URL/v1/messages \
  -H "Authorization: Bearer $SWITCHBOARD_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"cc/claude-sonnet-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hi"}]}'
```

## Response shape

OpenAI (`/v1/chat/completions`):

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "openai/gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello!" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10 }
}
```

Streaming (`stream: true`) emits SSE: `data: {choices:[{delta:{content:"..."}}]}\n\n` … `data: [DONE]\n\n`.

Anthropic (`/v1/messages`):

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "model": "cc/claude-sonnet-4-6",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 8, "output_tokens": 2 }
}
```

## Tips

- Tools / function calling: send OpenAI or Anthropic tool schemas as usual — Switchboard translates per upstream.
- Vision: include image parts in messages when the worker model supports vision.
- Auto combos re-pick a worker every request; do not assume sticky model identity across turns.
