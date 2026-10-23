"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/pi-settings";
const MANUAL_CONFIGS_ENDPOINT = "/api/cli-tools/pi-settings/manual-configs";

export default function PiToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      multipleModels
      hasDefaultModel
      requiresModelScope
      supportsModelLabels
      manualConfigsEndpoint={MANUAL_CONFIGS_ENDPOINT}
      installHint={`npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# or: curl -fsSL https://pi.dev/install.sh | sh`}
      runHint="After Apply: Switchboard is one provider. /model still lists your other providers."
    />
  );
}
