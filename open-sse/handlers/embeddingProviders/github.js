// GitHub Copilot embeddings — api.githubcopilot.com/embeddings with the short-lived Copilot token.
// The GitHub Models inference API (models.github.ai) was retired on 2026-07-30.
// Editor/integration identity headers come from the "copilot" identity profile
// (registry embeddingConfig.identity) applied by proxyAwareFetch.
import createOpenAIEmbeddingAdapter from "./openai.js";

const baseAdapter = createOpenAIEmbeddingAdapter("github");

const githubEmbeddingAdapter = {
  ...baseAdapter,
  buildHeaders: (creds) => ({
    "Content-Type": "application/json",
    "Authorization": `Bearer ${creds.copilotToken || creds.providerSpecificData?.copilotToken || creds.accessToken}`,
  }),
};

export default githubEmbeddingAdapter;
