"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/aider-settings";

// Keep in sync with buildAiderAliases in src/lib/cli/modelCatalog.js — slugs can
// collide (`a/b-c` and `a/b_c` both slug to a-b-c), so disambiguate with -2/-3.
export const buildAiderManualConfigs = ({ baseUrl, apiKey, model, models }) => {
  const aiderModel = model.startsWith("openai/") ? model : `openai/${model}`;
  const counts = new Map();
  const aliases = models.map((id) => {
    const slug = id.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
    const count = (counts.get(slug) || 0) + 1;
    counts.set(slug, count);
    const target = id.startsWith("openai/") ? id : `openai/${id}`;
    return `  - switchboard-${slug}${count === 1 ? "" : `-${count}`}:${target}`;
  }).join("\n");
  return [
    {
      filename: "~/.aider.conf.yml",
      content: `# switchboard-managed
openai-api-base: ${baseUrl}
openai-api-key: ${apiKey}
model: ${aiderModel}
alias:
${aliases}
`,
    },
  ];
};

export default function AiderToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      multipleModels
      installHint={`python -m pip install aider-chat
# or: pipx install aider-chat`}
      runHint="After Apply: aider   (uses ~/.aider.conf.yml)"
      buildManualConfigs={buildAiderManualConfigs}
    />
  );
}
