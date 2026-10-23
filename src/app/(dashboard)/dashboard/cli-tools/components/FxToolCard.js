"use client";
// @ts-check
import OpenAiCompatToolCard from "./OpenAiCompatToolCard";

const ENDPOINT = "/api/cli-tools/fx-settings";
const MANUAL_CONFIGS_ENDPOINT = "/api/cli-tools/fx-settings/manual-configs";

export default function FxToolCard(props) {
  return (
    <OpenAiCompatToolCard
      {...props}
      endpoint={ENDPOINT}
      multipleModels
      hasDefaultModel
      requiresModelScope
      manualConfigsEndpoint={MANUAL_CONFIGS_ENDPOINT}
      installHint="curl -fsSL https://fx.sh/install | sh"
      runHint="Effort/thinking: pick a level-specific model ID (e.g. alias/model(max)). FX custom connections do not send reasoning_effort to Switchboard — not fx --effort."
    />
  );
}
