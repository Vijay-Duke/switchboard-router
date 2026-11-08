/**
 * Tool registry for `switchboard connect` / `switchboard show`.
 *
 * The standalone CLI bundles the dashboard's file writers and invokes them
 * locally, without starting a server. Each entry describes:
 *
 *   - id / name / aliases    how the user selects the tool on the command line
 *   - needsModel             whether apply() requires at least one model id
 *   - buildBody(ctx)         the POST body for the existing writer route
 *   - summarize(getData)     a REDACTED summary of the writer's GET response
 *
 * ctx = { baseUrl (origin, no /v1 — each writer normalizes), apiKey, model }
 * claude additionally receives claudeModels: { envKey: model } for tier flags.
 *
 * summarize() must NEVER return a raw secret: keys come back either as
 * nothing (the route only exposes a boolean `apiKeySet`) or as a value that
 * show.js masks before printing. No secret is logged by the CLI itself.
 */

const CLAUDE_TIERS = [
  { flag: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus" },
  { flag: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet" },
  { flag: "fable", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL", label: "Fable" },
  { flag: "haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku" },
];

const isStr = (v) => typeof v === "string" && v.length > 0;
const bearerKey = (v) => (isStr(v) ? v.replace(/^Bearer\s+/i, "") : undefined);
const filePaths = (data, keys) => keys.map((k) => data?.[k]).filter(isStr);

// ── Claude Code (env-based writer) ──────────────────────────────────────────
const claude = {
  id: "claude",
  name: "Claude Code",
  aliases: ["claude-code", "claudecode"],
  needsModel: false,
  buildBody: ({ baseUrl, apiKey, claudeModels }) => {
    const env = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      API_TIMEOUT_MS: "600000",
    };
    for (const tier of CLAUDE_TIERS) {
      if (claudeModels?.[tier.envKey]) env[tier.envKey] = claudeModels[tier.envKey];
    }
    return { env, removeEnvKeys: CLAUDE_TIERS.filter(tier => !env[tier.envKey]).map(tier => tier.envKey) };
  },
  summarize: (data) => {
    const env = data?.settings?.env || {};
    const models = {};
    for (const tier of CLAUDE_TIERS) {
      if (isStr(env[tier.envKey])) models[tier.flag] = env[tier.envKey];
    }
    if (isStr(env.ANTHROPIC_MODEL)) models.main = env.ANTHROPIC_MODEL;
    return {
      baseUrl: env.ANTHROPIC_BASE_URL,
      apiKey: env.ANTHROPIC_AUTH_TOKEN,
      models,
      extra: isStr(data?.routingMode) ? { routingMode: data.routingMode } : {},
    };
  },
  files: (data) => filePaths(data, ["settingsPath"]),
};

// ── Single-model OpenAI-compatible writers ({ baseUrl, apiKey, model }) ─────
const simple = (id, name, aliases = [], files = ["configPath"]) => ({
  id,
  name,
  aliases,
  needsModel: true,
  buildBody: (ctx) => ({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, model: ctx.model }),
  summarize: summarizerFromSettings(),
  files: (data) => filePaths(data, files),
});

const codex = {
  id: "codex",
  name: "OpenAI Codex CLI",
  aliases: ["openai-codex"],
  needsModel: true,
  buildBody: ({ baseUrl, apiKey, model }) => ({
    baseUrl, apiKey, model, subagentModel: model,
  }),
  summarize: (data) => {
    const cfg = data?.config || {};
    const provider = cfg.model_providers?.switchboard;
    return {
      baseUrl: provider?.base_url,
      apiKey: bearerKey(provider?.http_headers?.Authorization),
      models: {
        ...(isStr(cfg.model) ? { main: cfg.model } : {}),
        ...(isStr(cfg.agents?.default_subagent_model) ? { subagent: cfg.agents.default_subagent_model } : {}),
      },
      // Codex only routes through Switchboard when our provider is selected.
      active: cfg.model_provider === "switchboard",
    };
  },
  files: (data) => filePaths(data, ["configPath"]),
};

const opencode = {
  id: "opencode",
  name: "OpenCode",
  aliases: [],
  needsModel: true,
  buildBody: ({ baseUrl, apiKey, model }) => ({
    baseUrl, apiKey, model, models: [model], activeModel: model, subagentModel: model,
  }),
  summarize: (data) => {
    const summary = data?.opencode || {};
    const provider = data?.config?.provider?.switchboard;
    return {
      baseUrl: summary.baseURL || provider?.options?.baseURL,
      apiKey: provider?.options?.apiKey,
      models: {
        ...(summary.activeModel ? { main: summary.activeModel } : {}),
        ...(Array.isArray(summary.models) && summary.models.length ? { available: summary.models.join(", ") } : {}),
      },
      active: typeof data?.config?.model === "string" && data.config.model.startsWith("switchboard/"),
    };
  },
  files: (data) => filePaths(data, ["configPath"]),
};

const droid = {
  id: "droid",
  name: "Factory Droid",
  aliases: ["factory"],
  needsModel: true,
  buildBody: ({ baseUrl, apiKey, model }) => ({
    baseUrl, apiKey, model, models: [model], activeModel: model,
  }),
  summarize: (data) => {
    const managed = (data?.settings?.customModels || []).filter(
      (m) => typeof m?.id === "string" && (m.id.startsWith("custom:Switchboard") || m.id.startsWith("custom:9Router")),
    );
    return {
      baseUrl: managed[0]?.baseUrl,
      apiKey: managed[0]?.apiKey,
      models: managed.length
        ? { main: managed[0].model, ...(managed.length > 1 ? { available: managed.map((m) => m.model).join(", ") } : {}) }
        : {},
    };
  },
  files: (data) => filePaths(data, ["settingsPath"]),
};

const modelListBody = (extra = () => ({})) => ({ baseUrl, apiKey, model }) => ({
  baseUrl, apiKey, model, models: [model], defaultModel: model, ...extra({ baseUrl, apiKey, model }),
});

const summarizerFromSettings = (pick = (s) => ({})) => (data) => {
  const s = data?.settings || {};
  return {
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    apiKeySet: typeof s.apiKeySet === "boolean" ? s.apiKeySet : undefined,
    models: {
      ...(isStr(s.model) ? { main: s.model } : {}),
      ...(Array.isArray(s.models) && s.models.length ? { available: s.models.join(", ") } : {}),
    },
    ...pick(s),
  };
};

const tools = [
  claude,
  codex,
  opencode,
  droid,
  simple("grok", "Grok CLI", ["grok-cli"], ["configPath", "envPath"]),
  {
    id: "deepseek-tui",
    name: "DeepSeek TUI",
    aliases: ["deepseek"],
    needsModel: true,
    buildBody: ({ baseUrl, apiKey, model }) => ({ baseUrl, apiKey, model }),
    summarize: (data) => {
      const openai = data?.settings?.providers?.openai || {};
      return {
        baseUrl: openai.base_url,
        apiKey: openai.api_key,
        models: isStr(openai.model) ? { main: openai.model } : {},
      };
    },
    files: (data) => filePaths(data, ["configPath"]),
  },
  {
    id: "jcode",
    name: "jcode",
    aliases: [],
    needsModel: true,
    buildBody: modelListBody(),
    summarize: (data) => {
      const provider = data?.config?.providers?.switchboard || {};
      return {
        baseUrl: provider.base_url,
        // env var holds the actual key — show.js masks it
        apiKey: data?.envApiKey,
        models: {
          ...(isStr(provider.default_model) ? { main: provider.default_model } : {}),
          ...(Array.isArray(provider.models) && provider.models.length
            ? { available: provider.models.map((m) => m?.id).filter(isStr).join(", ") }
            : {}),
        },
      };
    },
    files: (data) => filePaths(data, ["configPath"]),
  },
  {
    id: "cline",
    name: "Cline",
    aliases: ["cline-cli"],
    needsModel: true,
    buildBody: ({ baseUrl, apiKey, model }) => ({
      baseUrl, apiKey, model, models: [model], defaultModel: model, actModel: model, planModel: model,
    }),
    summarize: (data) => {
      const s = data?.settings || {};
      return {
        baseUrl: s.baseUrl,
        models: {
          ...(isStr(s.actModel) ? { act: s.actModel } : {}),
          ...(isStr(s.planModel) ? { plan: s.planModel } : {}),
          ...(Array.isArray(s.models) && s.models.length ? { available: s.models.join(", ") } : {}),
        },
      };
    },
    files: (data) => filePaths(data, ["providersPath", "modelsPath"]),
  },
  {
    id: "kilo",
    name: "Kilo Code",
    aliases: ["kilocode"],
    needsModel: true,
    buildBody: modelListBody(),
    summarize: summarizerFromSettings(),
    files: (data) => filePaths(data, ["configPath"]),
  },
  {
    id: "aider",
    name: "Aider",
    aliases: [],
    needsModel: true,
    buildBody: modelListBody(),
    summarize: summarizerFromSettings(),
    files: (data) => filePaths(data, ["configPath"]),
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    aliases: ["gemini"],
    needsModel: true,
    buildBody: modelListBody(),
    summarize: summarizerFromSettings(),
    files: (data) => filePaths(data, ["configPath", "settingsPath"]),
  },
  {
    id: "fx",
    name: "Fx",
    aliases: ["fx-coder"],
    needsModel: true,
    buildBody: modelListBody(),
    summarize: summarizerFromSettings(),
    files: (data) => filePaths(data, ["configPath"]),
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    aliases: [],
    needsModel: true,
    buildBody: modelListBody(),
    summarize: (data) => {
      const s = data?.settings || {};
      return {
        baseUrl: s.model?.base_url,
        models: {
          ...(isStr(s.defaultModel) ? { main: s.defaultModel } : {}),
          ...(Array.isArray(s.models) && s.models.length ? { available: s.models.join(", ") } : {}),
        },
      };
    },
    files: (data) => filePaths(data, ["configPath"]),
  },
  {
    id: "pi",
    name: "Pi",
    aliases: ["pi-coding-agent", "oh-my-pi", "omp"],
    needsModel: true,
    buildBody: modelListBody(),
    summarize: summarizerFromSettings((s) => (typeof s.scopeConfigured === "boolean" ? { scopeConfigured: s.scopeConfigured } : {})),
    files: (data) => filePaths(data, ["configPath", "settingsPath"]),
  },
  {
    id: "openclaw",
    name: "Open Claw",
    aliases: ["open-claw"],
    needsModel: true,
    buildBody: modelListBody(),
    summarize: (data) => {
      const provider = data?.settings?.models?.providers?.switchboard || {};
      return {
        baseUrl: provider.baseUrl || provider.base_url,
        apiKey: provider.apiKey,
        models: Array.isArray(provider.models) && provider.models.length
          ? { main: provider.models[0]?.id || provider.models[0], available: provider.models.map(m => m?.id || m).join(", ") }
          : {},
      };
    },
    files: (data) => filePaths(data, ["settingsPath"]),
  },
  {
    id: "cowork",
    name: "Claude Cowork",
    aliases: ["cowork"],
    needsModel: true,
    buildBody: ({ baseUrl, apiKey, model }) => ({ baseUrl, apiKey, models: [model] }),
    summarize: (data) => {
      const s = data?.cowork || {};
      return {
        baseUrl: s.baseUrl,
        apiKey: data?.config?.inferenceGatewayApiKey,
        models: {
          ...(Array.isArray(s.models) && s.models.length ? { available: s.models.map((m) => m?.name || m).join(", ") } : {}),
        },
        ...(isStr(s.appliedId) ? { note: `applied config: ${s.appliedId}` } : {}),
      };
    },
    files: (data) => filePaths(data, ["configPath"]),
  },
];

const TOOLS = tools;
const TOOL_IDS = tools.map((t) => t.id);
const TOOL_ALIASES = Object.fromEntries(tools.flatMap((t) => t.aliases.map((a) => [a, t.id])));

function findTool(id) {
  const normalized = String(id || "").trim().toLowerCase();
  return TOOLS.find((t) => t.id === normalized) || TOOLS.find((t) => t.aliases.includes(normalized)) || null;
}

function resolveTools(list) {
  const ids = [];
  for (const raw of list) {
    const id = String(raw).trim().toLowerCase();
    if (!id) continue;
    if (id === "all") {
      for (const t of TOOLS) if (!ids.includes(t.id)) ids.push(t.id);
      continue;
    }
    const tool = findTool(id);
    if (!tool) {
      throw new Error(`Unknown tool "${raw}". Supported: ${TOOL_IDS.join(", ")}, all`);
    }
    if (!ids.includes(tool.id)) ids.push(tool.id);
  }
  if (!ids.length) throw new Error("No tools selected");
  return TOOLS.filter((t) => ids.includes(t.id));
}

module.exports = {
  TOOLS,
  TOOL_IDS,
  TOOL_ALIASES,
  CLAUDE_TIERS,
  findTool,
  resolveTools,
};
