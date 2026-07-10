// MITM Tools — IDE tools intercepted via MITM proxy
export const MITM_TOOLS = {
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    image: "/providers/antigravity.png",
    color: "#4285F4",
    description: "Google Antigravity IDE with MITM",
    configType: "mitm",
    mitmDomain: "daily-cloudcode-pa.googleapis.com",
    modelAliases: ["gemini-3.5-flash-low", "gemini-3-flash-agent", "gemini-3.5-flash-extra-low", "gemini-3.1-pro-low", "gemini-pro-agent", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium", "gemini-3-flash"],
    defaultModels: [
      { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Medium) / Default", alias: "gemini-3.5-flash-low", mandatory: true },
      { id: "gemini-3-flash-agent", name: "Gemini 3.5 Flash (High)", alias: "gemini-3-flash-agent" },
      { id: "gemini-3.5-flash-extra-low", name: "Gemini 3.5 Flash (Low)", alias: "gemini-3.5-flash-extra-low" },
      { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", alias: "gemini-3.1-pro-low" },
      { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", alias: "gemini-pro-agent" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", alias: "claude-sonnet-4-6" },
      { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", alias: "claude-opus-4-6-thinking" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", alias: "gpt-oss-120b-medium" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash (Command)", alias: "gemini-3-flash" },
    ],
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    image: "/providers/copilot.png",
    color: "#1F6FEB",
    description: "GitHub Copilot IDE with MITM",
    configType: "mitm",
    mitmDomain: "api.individual.githubcopilot.com",
    modelAliases: ["gpt-5-mini", "gpt-5.4-nano", "claude-haiku-4.5", "gpt-4o", "gpt-4.1"],
    defaultModels: [
      // Verified via live MITM passthrough capture of the GitHub Copilot CLI: its model
      // picker offers "GPT-5 mini" (default → wire id "gpt-5-mini"), "Claude Haiku 4.5"
      // ("claude-haiku-4.5") and "Auto". "Auto" is NOT a wire id — Copilot dispatches
      // concrete models dynamically (observed "gpt-5.4-nano" for light tasks and
      // "claude-haiku-4.5"), so it needs no slot of its own. Without a slot for
      // gpt-5-mini / gpt-5.4-nano, getMappedModel returns null and the /chat/completions
      // call is passed through to GitHub Copilot instead of the configured provider —
      // and gpt-5-mini is the CLI default, so the primary turn leaks (same class as the
      // Kiro "auto" misrouting). gpt-4o / gpt-4.1 are kept for the VS Code Copilot Chat picker.
      { id: "gpt-5-mini", name: "GPT-5 mini", alias: "gpt-5-mini" },
      { id: "gpt-5.4-nano", name: "GPT-5.4 nano", alias: "gpt-5.4-nano" },
      { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", alias: "claude-haiku-4.5" },
      { id: "gpt-4o", name: "GPT-4o", alias: "gpt-4o" },
      { id: "gpt-4.1", name: "GPT-4.1", alias: "gpt-4.1" },
    ],
  },
  kiro: {
    id: "kiro",
    name: "Kiro",
    image: "/providers/kiro.png",
    color: "#FF6B00",
    description: "Kiro IDE with MITM",
    configType: "mitm",
    mitmDomain: "q.us-east-1.amazonaws.com",
    defaultModels: [
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", alias: "claude-sonnet-5" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", alias: "claude-sonnet-4.5" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", alias: "claude-sonnet-4" },
      { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", alias: "claude-haiku-4.5" },
      { id: "deepseek-3.2", name: "DeepSeek 3.2", alias: "deepseek-3.2" },
      { id: "minimax-m2.1", name: "MiniMax M2.1", alias: "minimax-m2.1" },
      { id: "simple-task", name: "Qwen3 Coder Next", alias: "simple-task" },
    ],
  },
  // cursor: {
  //   id: "cursor",
  //   name: "Cursor",
  //   image: "/providers/cursor.png",
  //   color: "#000000",
  //   description: "Cursor IDE with MITM",
  //   configType: "mitm",
  //   mitmDomain: "api2.cursor.sh",
  //   defaultModels: [
  //     { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", alias: "claude-sonnet-4-5" },
  //     { id: "claude-opus-4", name: "Claude Opus 4", alias: "claude-opus-4" },
  //     { id: "gpt-4o", name: "GPT-4o", alias: "gpt-4o" },
  //   ],
  // },
};

// CLI Tools configuration
export const CLI_TOOLS = {
  claude: {
    id: "claude",
    name: "Claude Code",
    image: "/providers/claude.png",
    color: "#D97757",
    description: "Anthropic Claude Code CLI",
    configType: "env",
    envVars: {
      baseUrl: "ANTHROPIC_BASE_URL",
      model: "ANTHROPIC_MODEL",
      opusModel: "ANTHROPIC_DEFAULT_OPUS_MODEL",
      sonnetModel: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      fableModel: "ANTHROPIC_DEFAULT_FABLE_MODEL",
      haikuModel: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    },
    modelAliases: ["default", "sonnet", "opus", "fable", "haiku", "opusplan"],
    settingsFile: "~/.claude/settings.json",
    defaultModels: [
      { id: "opus", name: "Claude Opus", alias: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", defaultValue: "cc/claude-opus-4-8" },
      { id: "sonnet", name: "Claude Sonnet", alias: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL", defaultValue: "cc/claude-sonnet-5" },
      { id: "fable", name: "Claude Fable", alias: "fable", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL", defaultValue: "cc/claude-fable-5" },
      { id: "haiku", name: "Claude Haiku", alias: "haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL", defaultValue: "cc/claude-haiku-4-5-20251001" },
    ],
  },
  openclaw: {
    id: "openclaw",
    name: "Open Claw",
    image: "/providers/openclaw.png",
    color: "#FF6B35",
    description: "Open Claw AI Assistant",
    configType: "custom",
  },
  codex: {
    id: "codex",
    name: "OpenAI Codex CLI / App",
    image: "/providers/codex.png",
    color: "#10A37F",
    description: "OpenAI Codex CLI",
    configType: "custom",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    image: "/providers/opencode.png",
    color: "#E87040",
    description: "OpenCode AI Terminal Assistant",
    configType: "custom",
  },
  cowork: {
    id: "cowork",
    name: "Claude Cowork",
    image: "/providers/claude.png",
    color: "#D97757",
    description: "Claude Desktop Cowork (third-party inference)",
    configType: "custom",
  },
  hermes: {
    id: "hermes",
    name: "Hermes Agent",
    image: "/providers/hermes.png",
    color: "#8B5CF6",
    description: "Nous Research self-improving AI agent",
    configType: "custom",
  },
  droid: {
    id: "droid",
    name: "Factory Droid",
    image: "/providers/droid.png",
    color: "#00D4FF",
    description: "Factory Droid AI Assistant",
    configType: "custom",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    image: "/providers/cursor.png",
    color: "#000000",
    description: "Cursor AI Code Editor",
    configType: "guide",
    modelSelection: "multiple",
    requiresExternalUrl: true,
    notes: [
      { type: "warning", text: "Requires Cursor Pro account to use this feature." },
      { type: "cloudCheck", text: "Cursor routes requests through its own server, so local endpoint is not supported. Please enable Tunnel or Cloud Endpoint in Settings." },
    ],
    guideSteps: [
      { step: 1, title: "Open Settings", desc: "Go to Settings → Models" },
      { step: 2, title: "Enable OpenAI API", desc: "Enable \"OpenAI API key\" option" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "API Key", type: "apiKeySelector" },
      { step: 5, title: "Select Models", type: "modelSelector" },
      { step: 6, title: "Add Custom Models", desc: "Click “View All Models” → “Add Custom Model” once for each selected model. The endpoint and API key are shared." },
    ],
  },
  cline: {
    id: "cline",
    name: "Cline",
    image: "/providers/cline.png",
    color: "#00D1B2",
    description: "Cline AI Coding Assistant",
    configType: "custom",
  },
  kilo: {
    id: "kilo",
    name: "Kilo Code",
    image: "/providers/kilocode.png",
    color: "#FF6B6B",
    description: "Kilo Code AI Assistant",
    configType: "custom",
  },
  roo: {
    id: "roo",
    name: "Roo",
    image: "/providers/roo.png",
    color: "#FF6B6B",
    description: "Roo AI Assistant",
    configType: "guide",
    modelSelection: "multiple",
    guideSteps: [
      { step: 1, title: "Open Settings", desc: "Go to Roo Settings panel" },
      { step: 2, title: "Select Provider", desc: "Choose API Provider → OpenAI Compatible" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "API Key", type: "apiKeySelector" },
      { step: 5, title: "Select Models", type: "modelSelector" },
      { step: 6, title: "Create Profiles", desc: "Create one named Switchboard API Configuration Profile per selected model; Roo stores one model per profile." },
    ],
  },
  continue: {
    id: "continue",
    name: "Continue",
    image: "/providers/continue.png",
    color: "#7C3AED",
    description: "Continue AI Assistant",
    configType: "guide",
    modelSelection: "multiple",
    guideSteps: [
      { step: 1, title: "Open Config", desc: "Open Continue configuration file" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Select Models", type: "modelSelector" },
      { step: 4, title: "Add Model Config", desc: "Merge the generated entries into ~/.continue/config.yaml." },
    ],
    codeBlock: {
      language: "yaml",
      code: ({ baseUrl, apiKey, models }) => `name: Switchboard\nversion: 1.0.0\nschema: v1\nmodels:\n${models.map((model) => `  - name: "Switchboard · ${model}"\n    provider: openai\n    model: "${model}"\n    apiBase: "${baseUrl}"\n    apiKey: "${apiKey}"\n    roles: [chat, edit, apply]`).join("\n")}`,
    },
  },
  qwen: {
    id: "qwen",
    name: "Qwen Code",
    image: "/providers/qwen.png",
    color: "#10B981",
    description: "Alibaba Qwen Code CLI — supports OpenAI, Anthropic & Gemini providers via Switchboard",
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
    configType: "guide",
    modelSelection: "multiple",
    defaultCommand: "qwen",
    notes: [
      { type: "info", text: "Qwen Code supports multiple provider types (openai, anthropic, gemini) via modelProviders in settings.json. Switchboard works as an OpenAI-compatible endpoint." },
      { type: "info", text: "Any model available in Switchboard can be used — not just Qwen models. Select from Qwen, Claude, Gemini, GPT, and more." },
      { type: "warning", text: "Config path: Linux/macOS ~/.qwen/settings.json • Windows %USERPROFILE%\\.qwen\\settings.json" },
      { type: "error", text: "Qwen OAuth free tier was discontinued on 2026-04-15. Use Switchboard with alicode/openrouter/anthropic/gemini providers instead." },
    ],
    modelAliases: ["coder-model", "qwen3-coder-plus", "qwen3-coder-flash", "vision-model", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gemini-3-flash", "gemini-3.1-pro-high"],
    defaultModels: [
      { id: "coder-model", name: "Coder Model (Qwen 3.6 Plus)", alias: "coder-model", envKey: "OPENAI_MODEL", defaultValue: "coder-model", isTopLevel: true },
      { id: "qwen3-coder-plus", name: "Qwen 3 Coder Plus", alias: "qwen3-coder-plus", envKey: "OPENAI_MODEL", defaultValue: "qwen3-coder-plus" },
      { id: "qwen3-coder-flash", name: "Qwen 3 Coder Flash", alias: "qwen3-coder-flash", envKey: "OPENAI_MODEL", defaultValue: "qwen3-coder-flash" },
      { id: "vision-model", name: "Vision Model (Multimodal)", alias: "vision-model", envKey: "OPENAI_MODEL", defaultValue: "vision-model" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", alias: "claude-sonnet-4-6", envKey: "OPENAI_MODEL", defaultValue: "claude-sonnet-4-6" },
      { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking", alias: "claude-opus-4-6-thinking", envKey: "OPENAI_MODEL", defaultValue: "claude-opus-4-6-thinking" },
      { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro High", alias: "gemini-3.1-pro-high", envKey: "OPENAI_MODEL", defaultValue: "gemini-3.1-pro-high" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash", alias: "gemini-3-flash", envKey: "OPENAI_MODEL", defaultValue: "gemini-3-flash" },
    ],
    guideSteps: [
      { step: 1, title: "Install Qwen Code", desc: "npm install -g @qwen-code/qwen-code" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Models", type: "modelSelector" },
      { step: 5, title: "Save Config", desc: "Copy the JSON below to ~/.qwen/settings.json and export SWITCHBOARD_API_KEY in your shell." },
    ],
    codeBlock: {
      language: "json",
      code: ({ baseUrl, models }) => JSON.stringify({
        modelProviders: {
          openai: {
            protocol: "openai",
            models: models.map((id) => ({
              id,
              name: `Switchboard · ${id}`,
              baseUrl,
              envKey: "SWITCHBOARD_API_KEY",
            })),
          },
        },
      }, null, 2),
    },
  },
  "deepseek-tui": {
    id: "deepseek-tui",
    name: "DeepSeek TUI",
    image: "/providers/deepseek-tui.png",
    color: "#4D6BFE",
    description: "DeepSeek Terminal Coding Agent (Rust TUI)",
    docsUrl: "https://github.com/Hmbown/DeepSeek-TUI",
    configType: "custom",
    defaultCommand: "deepseek",
    modelAliases: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    defaultModels: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", alias: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", alias: "deepseek-v4-flash" },
      { id: "deepseek-chat", name: "DeepSeek V3 Chat", alias: "deepseek-chat" },
    ],
    notes: [
      { type: "info", text: "DeepSeek TUI uses ~/.deepseek/config.toml for configuration. Switchboard will update the provider to 'openai' mode with your base_url, api_key, and model." },
      { type: "warning", text: "Config path: Linux/macOS ~/.deepseek/config.toml • Windows %USERPROFILE%\\.deepseek\\config.toml" },
    ],
  },
  jcode: {
    id: "jcode",
    name: "jcode",
    image: "/providers/jcode.png",
    color: "#FF6B35",
    description: "High-performance Rust-based coding agent harness",
    configType: "custom",
    docsUrl: "https://github.com/1jehuang/jcode",
    notes: [
      {
        type: "info",
        text: "jcode is a Rust-based coding agent with semantic memory, multi-agent swarms, and extreme performance (27.8 MB RAM, 14ms boot)."
      },
      {
        type: "info",
        text: "Configure switchboard as an OpenAI-compatible provider to route all jcode requests through switchboard's optimization layer."
      },
      {
        type: "warning",
        text: "Requires jcode installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash"
      },
    ],
    defaultModels: [
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", alias: "opus", defaultValue: "cc/claude-opus-4-7" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", alias: "sonnet", defaultValue: "cc/claude-sonnet-4-6" },
      { id: "gpt-5.5", name: "GPT 5.5", alias: "gpt5", defaultValue: "cx/gpt-5.5" },
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", alias: "gemini", defaultValue: "gemini/gemini-3.1-pro" },
    ],
  },
  grok: {
    id: "grok",
    name: "Grok CLI",
    image: "/providers/xai.png",
    color: "#000000",
    description: "Open-source Grok terminal coding agent (grok-dev) via Switchboard",
    docsUrl: "https://github.com/superagent-ai/grok-cli",
    configType: "custom",
    defaultCommand: "grok",
    notes: [
      {
        type: "info",
        when: "installed",
        text: "Writes ~/.grok/user-settings.json (apiKey, defaultModel) and ~/.grok/switchboard.env (GROK_BASE_URL). Source the env file before launching grok — the CLI only reads base URL from the environment.",
      },
      {
        type: "install",
        when: "not_installed",
        text: "Install: curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash  ·  or  bun add -g grok-dev",
      },
    ],
    defaultModels: [
      { id: "xai/grok-4", name: "Grok 4", alias: "grok-4", defaultValue: "xai/grok-4" },
      { id: "xai/grok-3", name: "Grok 3", alias: "grok-3", defaultValue: "xai/grok-3" },
      { id: "xai/grok-3-mini", name: "Grok 3 Mini", alias: "grok-3-mini", defaultValue: "xai/grok-3-mini" },
    ],
  },
  pi: {
    id: "pi",
    name: "Pi",
    image: "/providers/pi.svg",
    color: "#38BDF8",
    description: "Minimal terminal coding agent (pi.dev) with custom OpenAI-compatible provider",
    docsUrl: "https://pi.dev",
    configType: "custom",
    defaultCommand: "pi",
    notes: [
      {
        type: "info",
        when: "installed",
        text: "Adds a switchboard provider to ~/.pi/agent/models.json. In Pi use /model (Ctrl+L) and pick switchboard/<model-id>.",
      },
      {
        type: "install",
        when: "not_installed",
        text: "Install: npm install -g --ignore-scripts @earendil-works/pi-coding-agent  ·  or  curl -fsSL https://pi.dev/install.sh | sh",
      },
    ],
  },
  aider: {
    id: "aider",
    name: "Aider",
    image: "/providers/aider.svg",
    color: "#34D399",
    description: "AI pair programming in your terminal (OpenAI-compatible)",
    docsUrl: "https://aider.chat",
    configType: "custom",
    defaultCommand: "aider",
    notes: [
      {
        type: "info",
        when: "installed",
        text: "Writes ~/.aider.conf.yml with openai-api-base, openai-api-key, and model (openai/<id>).",
      },
      {
        type: "install",
        when: "not_installed",
        text: "Install: pipx install aider-chat  ·  or  python -m pip install aider-chat",
      },
    ],
  },
  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    image: "/providers/gemini-cli.png",
    color: "#4285F4",
    description: "Google Gemini CLI pointed at Switchboard (OpenAI-compatible env)",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    configType: "custom",
    defaultCommand: "gemini",
    notes: [
      {
        type: "info",
        when: "installed",
        text: "Writes ~/.gemini/switchboard.env (OPENAI_* + GEMINI_*). Source it before running gemini so requests hit Switchboard.",
      },
      {
        type: "install",
        when: "not_installed",
        text: "Install: npm install -g @google/gemini-cli",
      },
    ],
  },
};

// Get all provider models for mapping dropdown
export const getProviderModelsForMapping = (providers) => {
  const result = [];
  providers.forEach(conn => {
    if (conn.isActive && (conn.testStatus === "active" || conn.testStatus === "success")) {
      result.push({
        connectionId: conn.id,
        provider: conn.provider,
        name: conn.name,
        models: conn.models || [],
      });
    }
  });
  return result;
};
