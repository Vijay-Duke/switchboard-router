"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/gemini-cli-settings";

export default function GeminiCliToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      installHint={`npm install -g @google/gemini-cli
# binary: gemini`}
      runHint="After Apply: source ~/.gemini/switchboard.env && gemini"
      buildManualConfigs={({ baseUrl, apiKey, model }) => [
        {
          filename: "~/.gemini/switchboard.env",
          content: `export OPENAI_API_KEY="${apiKey}"
export OPENAI_BASE_URL="${baseUrl}"
export OPENAI_MODEL="${model}"
export GEMINI_API_KEY="${apiKey}"
export GEMINI_API_BASE_URL="${baseUrl}"
export GEMINI_MODEL="${model}"
`,
        },
      ]}
    />
  );
}
