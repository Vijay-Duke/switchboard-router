"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/gemini-cli-settings";

export default function GeminiCliToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      multipleModels
      installHint={`npm install -g @google/gemini-cli
# binary: gemini`}
      runHint="After Apply: source ~/.gemini/.env && gemini"
      buildManualConfigs={({ baseUrl, apiKey, model, models }) => [
        {
          filename: "~/.gemini/.env",
          content: `# switchboard-managed
export GEMINI_API_KEY="${apiKey}"
export GEMINI_MODEL="${model}"
export GOOGLE_GEMINI_BASE_URL="${baseUrl.replace(/\/v1$/, "")}"
`,
        },
        {
          // Apply merges these keys into the existing file; tell manual
          // followers to do the same instead of replacing the whole file (T56).
          filename: "~/.gemini/settings.json (merge these keys — keep your other settings)",
          content: JSON.stringify({
            model: { name: model },
            experimental: { dynamicModelConfiguration: true },
            modelConfigs: {
              modelDefinitions: Object.fromEntries(models.map((id) => [id, {
                displayName: `Switchboard · ${id.split("/").pop() || id}`,
                family: "switchboard",
                tier: "custom",
                isPreview: false,
                isVisible: true,
                features: { thinking: true, multimodalToolUse: true },
              }])),
            },
          }, null, 2),
        },
      ]}
    />
  );
}
