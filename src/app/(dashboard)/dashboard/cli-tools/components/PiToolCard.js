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
      runHint="After Apply: Switchboard is one provider. /model still lists your other providers."
      buildManualConfigs={({ baseUrl, apiKey, models, defaultModel, pickerLabels }) => [
        {
          filename: "~/.pi/agent/models.yml",
          content: [
            "providers:",
            "  switchboard:",
            `    baseUrl: ${baseUrl}`,
            "    api: openai-completions",
            `    apiKey: ${apiKey}`,
            "    authHeader: true",
            "    compat:",
            "      supportsDeveloperRole: false",
            "      supportsReasoningEffort: true",
            "      supportsUsageInStreaming: true",
            "    discovery:",
            "      type: openai-models-list",
            "    models:",
            ...models.flatMap((model) => [
              `    - id: ${model}`,
              `      name: ${JSON.stringify(pickerLabels[model] || model.split("/").pop() || model)}`,
            ]),
          ].join("\n"),
        },
        {
          filename: "~/.pi/agent/settings.json",
          content: JSON.stringify(
            {
              defaultProvider: "switchboard",
              defaultModel: defaultModel || models[0],
            },
            null,
            2
          ),
        },
      ]}
    />
  );
}
