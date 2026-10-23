const moduleDefault = {
  id: "github",
  priority: 40,
  alias: "gh",
  uiAlias: "gh",
  display: {
    name: "GitHub Copilot",
    icon: "code",
    color: "#333333",
    website: "https://github.com/features/copilot",
    notice: {
      signupUrl: "https://github.com/features/copilot",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  transport: {
    identity: "copilot",
    baseUrl: "https://api.githubcopilot.com/chat/completions",
    responsesUrl: "https://api.githubcopilot.com/responses",
    usage: {
      url: "https://api.github.com/copilot_internal/user",
    },
  },
  models: [
    // Public chat models verified against GitHub's supported-models documentation
    // and the Copilot /models catalog (2026-10-19). Live account discovery remains
    // authoritative; internal aliases and utility-only models are not seeded here.
    // https://docs.github.com/en/copilot/reference/ai-models/supported-models
    { id: "gpt-5-mini", name: "GPT-5 Mini" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    // Note: routing to Copilot's Anthropic-native /v1/messages shim (see
    // executors/github.js) is decided by model-NAME pattern at request time, not by
    // a static targetFormat field here — Copilot's live model catalog (see
    // services/copilotModels.js) regularly exposes claude-* models this static list
    // hasn't caught up with yet, and a static per-entry
    // targetFormat would silently miss those while also double-translating requests
    // for models that ARE listed here (chatCore.js would pre-translate to Claude
    // shape, then the executor would translate again). Keep these as plain entries.
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-fable-5.1", name: "Claude Fable 5.1" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4.8-fast", name: "Claude Opus 4.8 (Fast)" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-4-argon", name: "Gemini 4 Argon" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "mai-code-1.1-flash", name: "MAI-Code-1.1-Flash" },
    { id: "text-embedding-3-small", name: "Text Embedding 3 Small (GitHub)", kind: "embedding" },
    { id: "text-embedding-ada-002", name: "Text Embedding Ada 002 (GitHub)", kind: "embedding" },
  ],
  serviceKinds: ["llm","embedding"],
  // GitHub Models inference (models.github.ai) was retired 2026-07-30; Copilot serves embeddings.
  embeddingConfig: { identity: "copilot", baseUrl: "https://api.githubcopilot.com/embeddings", authType: "apikey", authHeader: "bearer" },
  oauth: {
    clientId: "Iv1.b507a08c87ecfe98",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: "read:user",
    apiVersion: "2022-11-28",
    copilotTokenUrl: "https://api.github.com/copilot_internal/v2/token",
  },
  features: {
    usage: true,
  },
};

export default moduleDefault;
