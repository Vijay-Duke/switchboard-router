const moduleDefault = {
  id: "selfhosted-embedding",
  priority: 50,
  alias: "selfhosted-embedding",
  display: {
    name: "Self-hosted Embedding",
    icon: "data_array",
    color: "#14B8A6",
    textIcon: "SE",
    website: "https://github.com/ggml-org/llama.cpp",
  },
  category: "apikey",
  authType: "apikey",
  models: [
    { id: "embedding", name: "Self-hosted embedding model", kind: "embedding" },
  ],
  serviceKinds: ["embedding"],
  embeddingConfig: {
    identity: "openai-node",
    authType: "none",
    authHeader: "bearer",
    format: "openai",
  },
};

export default moduleDefault;
