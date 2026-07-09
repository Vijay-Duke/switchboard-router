"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/pi-settings";

export default function PiToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      installHint={`npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# or: curl -fsSL https://pi.dev/install.sh | sh`}
      runHint="After Apply: pi → /model → switchboard/<model>"
      buildManualConfigs={({ baseUrl, apiKey, model }) => [
        {
          filename: "~/.pi/agent/models.json",
          content: JSON.stringify(
            {
              providers: {
                switchboard: {
                  baseUrl,
                  api: "openai-completions",
                  apiKey,
                  authHeader: true,
                  compat: {
                    supportsDeveloperRole: false,
                    supportsReasoningEffort: true,
                  },
                  models: [
                    {
                      id: model,
                      name: model,
                      input: ["text", "image"],
                      contextWindow: 200000,
                      maxTokens: 16384,
                    },
                  ],
                },
              },
            },
            null,
            2
          ),
        },
      ]}
    />
  );
}
