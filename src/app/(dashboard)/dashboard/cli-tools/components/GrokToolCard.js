"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/grok-settings";

export default function GrokToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      installHint={`curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash
# or: bun add -g grok-dev`}
      runHint="After Apply: source ~/.grok/switchboard.env && grok"
      buildManualConfigs={({ baseUrl, apiKey, model }) => [
        {
          filename: "~/.grok/user-settings.json",
          content: JSON.stringify({ apiKey, defaultModel: model }, null, 2),
        },
        {
          filename: "~/.grok/switchboard.env",
          content: `export GROK_API_KEY="${apiKey}"
export GROK_BASE_URL="${baseUrl}"
export GROK_MODEL="${model}"
`,
        },
      ]}
    />
  );
}
