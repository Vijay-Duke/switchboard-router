
const moduleDefault = {
  id: "claude",
  priority: 10,
  alias: "cc",
  uiAlias: "cc",
  display: {
    name: "Claude Code",
    icon: "smart_toy",
    color: "#D97757",
    website: "https://claude.ai",
    notice: {
      signupUrl: "https://claude.ai",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  transport: {
    identity: "claude-cli",
    baseUrl: "https://api.anthropic.com/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
    },
    quirks: {
      cloakToolsOnOAuth: true,
    },
    auth: {
      apiKey: {
        header: "x-api-key",
        scheme: "raw",
      },
      oauth: {
        header: "Authorization",
        scheme: "bearer",
      },
    },
    usage: {
      oauthUrl: "https://api.anthropic.com/api/oauth/usage",
      orgUrl: "https://api.anthropic.com/v1/organizations/{org_id}/usage",
      settingsUrl: "https://api.anthropic.com/v1/settings",
    },
  },
  models: [
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
  ],
  oauth: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scopes: [
      "org:create_api_key",
      "user:profile",
      "user:inference",
    ],
    codeChallengeMethod: "S256",
    refreshLeadMs: 14400000,
    refresh: {
      encoding: "json",
    },
  },
  features: {
    usage: true,
  },
};

export default moduleDefault;
