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
      buildManualConfigs={({ baseUrl, apiKey, models, defaultModel, pickerLabels }) => {
        // Mirror buildPiModelEntries + the pi-settings route so manual followers
        // get the same entry metadata (T88) and both Pi config halves (T87):
        // omp (Pi >= v18) reads models.yml; plain pi still reads models.json.
        const entries = models.map((model) => ({
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 200000,
          maxTokens: 16384,
          id: model,
          name: String(pickerLabels[model] || "").trim().slice(0, 48)
            || model.split("/").pop()
            || model,
        }));
        const provider = {
          baseUrl,
          api: "openai-completions",
          apiKey,
          authHeader: true,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            supportsUsageInStreaming: true,
          },
          models: entries,
        };
        const ymlEntry = (entry) => [
          `    - id: ${entry.id}`,
          `      name: ${JSON.stringify(entry.name)}`,
          "      reasoning: false",
          '      input: ["text", "image"]',
          "      contextWindow: 200000",
          "      maxTokens: 16384",
        ].join("\n");
        return [
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
              ...entries.map(ymlEntry),
            ].join("\n"),
          },
          {
            filename: "~/.pi/agent/models.json",
            content: JSON.stringify({ providers: { switchboard: provider } }, null, 2),
          },
          {
            // Apply only sets these two keys and preserves the rest (enabledModels…);
            // merge rather than replace the file (T86).
            filename: "~/.pi/agent/settings.json (merge these keys — keep your other settings)",
            content: JSON.stringify(
              {
                defaultProvider: "switchboard",
                defaultModel: defaultModel || models[0],
              },
              null,
              2
            ),
          },
        ];
      }}
    />
  );
}
