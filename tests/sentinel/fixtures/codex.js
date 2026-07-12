export const request = {
  model: "gpt-5-codex",
  instructions: "You are a precise coding assistant. Summarize the supplied weather context concisely.",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "What is the weather in NYC?"
        },
        {
          type: "input_image",
          image_url: "data:image/png;base64,IMG"
        }
      ]
    },
    {
      type: "function_call",
      call_id: "call_abc",
      name: "get_weather",
      arguments: "{\"city\":\"NYC\"}"
    },
    {
      type: "function_call_output",
      call_id: "call_abc",
      output: "sunny"
    }
  ],
  tools: [
    {
      type: "function",
      name: "get_weather",
      description: "Get the weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" }
        },
        required: ["city"],
        additionalProperties: false
      }
    }
  ],
  stream: true
};

export const upstreamChunks = [
  {
    id: "chatcmpl-codex-1234567890",
    object: "chat.completion.chunk",
    created: 1735689600,
    model: "gpt-5-codex",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "Hello" },
        finish_reason: null
      }
    ]
  },
  {
    id: "chatcmpl-codex-1234567890",
    object: "chat.completion.chunk",
    created: 1735689600,
    model: "gpt-5-codex",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: {
                name: "get_weather",
                arguments: "{\"city\":\"NYC\"}"
              }
            }
          ]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "chatcmpl-codex-1234567890",
    object: "chat.completion.chunk",
    created: 1735689600,
    model: "gpt-5-codex",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls"
      }
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 18,
      total_tokens: 138,
      prompt_tokens_details: {
        cached_tokens: 10
      }
    }
  }
];
