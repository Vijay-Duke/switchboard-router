"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/pi-settings";

export default function PiToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      multipleModels
      hasDefaultModel
      requiresModelScope
      supportsModelLabels
      installHint={`npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# or: curl -fsSL https://pi.dev/install.sh | sh`}
      runHint="After Apply: pi starts with the selected default and /model only cycles through these Switchboard models"
      buildManualConfigs={({ baseUrl, apiKey, models, defaultModel, pickerLabels }) => [
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
                  models: models.map((model) => (
                    {
                      id: model,
                      name: pickerLabels[model] || model.split("/").pop() || model,
                      input: ["text", "image"],
                      contextWindow: 200000,
                      maxTokens: 16384,
                    }
                  )),
                },
              },
            },
            null,
            2
          ),
        },
        {
          filename: "~/.pi/agent/settings.json",
          content: JSON.stringify(
            {
              defaultProvider: "switchboard",
              defaultModel: defaultModel || models[0],
              enabledModels: models.map((model) => `switchboard/${model}`),
            },
            null,
            2
          ),
        },
      ]}
    />
  );
}
