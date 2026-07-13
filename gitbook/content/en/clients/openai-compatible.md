# OpenAI-Compatible Clients

Any client that accepts a custom OpenAI base URL can usually talk to Switchboard.

## Settings

```text
Base URL: http://localhost:20128/v1
API Key:  sk_switchboard
Model:    pick from /v1/models or use a combo name
```

## JavaScript

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:20128/v1",
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await client.chat.completions.create({
  model: "your-model-or-combo",
  messages: [{ role: "user", content: "Say hello" }],
});

console.log(response.choices[0].message.content);
```

## Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:20128/v1",
    api_key="sk_switchboard",
)

response = client.chat.completions.create(
    model="your-model-or-combo",
    messages=[{"role": "user", "content": "Say hello"}],
)

print(response.choices[0].message.content)
```

## Available Endpoints

The app includes OpenAI-style routes for models, chat completions, responses, embeddings, image generation, speech, transcription, search, and web fetch. Provider support varies by model and service kind.
