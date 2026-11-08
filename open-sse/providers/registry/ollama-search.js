const moduleDefault = {
  id: "ollama-search",
  alias: "ollama-search",
  display: {
    name: "Ollama Search",
    icon: "cloud",
    color: "#ffffff",
    textIcon: "OL",
    website: "https://ollama.com",
    notice: {
      text: "Web search via Ollama Cloud subscription. Reuses the API key from the Ollama (chat) provider.",
      apiKeyUrl: "https://ollama.com/settings/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  serviceKinds: ["webSearch"],
  // Credential fallback: reuses the API key registered under the `ollama`
  // chat provider — one key, chat + search. The search endpoint is unrelated
  // to the Ollama chat transport, so this stays a separate provider entry.
  credentialFallback: "ollama",
  searchConfig: {
    baseUrl: "https://ollama.com/api/web_search",
    method: "POST",
    authType: "apikey",
    authHeader: "bearer",
    costPerQuery: 0,
    freeMonthlyQuota: 1000,
    searchTypes: ["web"],
    defaultMaxResults: 5,
    maxMaxResults: 10,
    timeoutMs: 10000,
    cacheTTLMs: 300000,
  },
};

export default moduleDefault;
