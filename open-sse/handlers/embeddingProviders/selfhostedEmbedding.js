import createOpenAIEmbeddingAdapter from "./openai.js";

const baseAdapter = createOpenAIEmbeddingAdapter("openai");

const moduleDefault = {
  ...baseAdapter,
  buildUrl: (_model, credentials) => {
    const raw = credentials?.providerSpecificData?.baseUrl?.trim();
    if (!raw) throw new Error("Self-hosted Embedding requires a connection base URL");
    const parsed = new URL(raw);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      throw new Error("Self-hosted Embedding base URL must use http or https");
    }
    return `${raw.replace(/\/+$/, "").replace(/\/embeddings$/, "")}/embeddings`;
  },
  buildHeaders: (credentials) => ({
    "Content-Type": "application/json",
    ...(credentials?.apiKey || credentials?.accessToken
      ? { Authorization: `Bearer ${credentials.apiKey || credentials.accessToken}` }
      : {}),
  }),
};

export default moduleDefault;
