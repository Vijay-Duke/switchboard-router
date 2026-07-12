export const request = {
  model: "gemini-2.5-pro",
  stream: true,
  systemInstruction: {
    role: "user",
    parts: [{ text: "You are helpful." }]
  },
  contents: [
    {
      role: "user",
      parts: [{ text: "What's the weather in NYC?" }]
    },
    {
      role: "model",
      parts: [{ functionCall: { name: "get_weather", args: { city: "NYC" } } }]
    },
    {
      role: "user",
      parts: [{ functionResponse: { name: "get_weather", response: { result: "sunny" } } }]
    }
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"]
          }
        }
      ]
    }
  ],
  generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
};

export const upstreamChunks = [
  {
    candidates: [{ content: { parts: [{ text: "It is sunny" }] } }],
    responseId: "resp_1",
    modelVersion: "gemini-2.5-pro"
  },
  {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: "get_weather", args: { city: "NYC" } } }]
        }
      }
    ]
  },
  {
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 8,
      candidatesTokenCount: 4,
      totalTokenCount: 12
    }
  }
];
