"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/aider-settings";

export default function AiderToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      installHint={`python -m pip install aider-chat
# or: pipx install aider-chat`}
      runHint="After Apply: aider   (uses ~/.aider.conf.yml)"
      buildManualConfigs={({ baseUrl, apiKey, model }) => {
        const aiderModel = model.startsWith("openai/") ? model : `openai/${model}`;
        return [
          {
            filename: "~/.aider.conf.yml",
            content: `# switchboard-managed
openai-api-base: ${baseUrl}
openai-api-key: ${apiKey}
model: ${aiderModel}
`,
          },
        ];
      }}
    />
  );
}
