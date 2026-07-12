export const request = {
  model: "claude-sonnet-4-20250514",
  system: [
    {
      type: "text",
      text: "You are Claude Code, an agentic coding assistant. Work carefully and report concise results."
    }
  ],
  messages: [
    {
      role: "user",
      content: "Read /workspace/switchboard/package.json and tell me the application name."
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01ClaudeCodeRead",
          name: "Read",
          input: {
            file_path: "/workspace/switchboard/package.json",
            limit: 200
          }
        }
      ]
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01ClaudeCodeRead",
          content: "{\"name\":\"switchboard-app\"}"
        }
      ]
    }
  ],
  tools: [
    {
      name: "Read",
      description: "Read the contents of a file from the workspace.",
      input_schema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path of the file to read."
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to return."
          }
        },
        required: ["file_path"]
      }
    }
  ],
  max_tokens: 4096,
  thinking: {
    type: "enabled",
    budget_tokens: 2048
  }
};

export const upstreamChunks = [
  {
    id: "chatcmpl-claude-code-1234567890",
    object: "chat.completion.chunk",
    created: 1735689600,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: "I will read the package manifest."
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "chatcmpl-claude-code-1234567890",
    object: "chat.completion.chunk",
    created: 1735689600,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_claude_code_read",
              type: "function",
              function: {
                name: "Read",
                arguments: "{\"file_path\":\"/workspace/switchboard/package.json\",\"limit\":200}"
              }
            }
          ]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "chatcmpl-claude-code-1234567890",
    object: "chat.completion.chunk",
    created: 1735689600,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls"
      }
    ],
    usage: {
      prompt_tokens: 842,
      completion_tokens: 57,
      total_tokens: 899
    }
  }
];
