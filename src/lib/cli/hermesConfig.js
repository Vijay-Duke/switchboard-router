// @ts-check

// Hermes `config.yaml` / `.env` reading helpers shared by the settings route,
// the profile discovery module and the model-catalog writer.
//
// Switchboard registers itself as a named Hermes custom provider and points the
// top-level model slots at it, instead of embedding base_url/api_key in every
// block:
//
//   custom_providers:
//     - name: switchboard
//       base_url: "http://127.0.0.1:20128/v1"
//       key_env: SWITCHBOARD_API_KEY
//       api_mode: chat_completions
//       models:
//         "provider/model-id": {}
//   model:                      # main model (fresh installs ship the `model: ""` sentinel)
//     default: "provider/model-id"
//     provider: "custom:switchboard"
//   delegation:                 # subagent model — same provider reference
//     model: "provider/model-id"
//     provider: "custom:switchboard"
//   auxiliary:                  # per-role model slots — same provider reference
//     vision:
//       model: "provider/model-id"
//       provider: "custom:switchboard"
//   stt:                        # audio transcription via the OpenAI-SDK-shaped backend
//     enabled: true
//     provider: "openai"
//     openai:
//       model: "provider/whisper-model-id"
//       base_url: "http://127.0.0.1:20128/v1"
//       api_key: ${SWITCHBOARD_API_KEY}
//
// Reading is Document/plain-parse based (no regex) except for the legacy
// pre-provider `model:` block our fork wrote before custom_providers existed.

import { parse as parseYaml } from "yaml";

export const HERMES_PROVIDER_NAME = "switchboard";
export const HERMES_PROVIDER_REF = "custom:switchboard";
export const HERMES_API_KEY_ENV = "SWITCHBOARD_API_KEY";
export const HERMES_STT_API_KEY_REF = "${SWITCHBOARD_API_KEY}";

// Auxiliary role names become YAML keys inside "auxiliary:" — keep them inert.
export const AUX_ROLE_KEY_RE = /^[A-Za-z0-9_]+$/;

// ── legacy model block (pre custom_providers writes) ─────────────────────────
// Old shape: `model:\n  default: "..."\n  provider: "custom"\n  base_url: "http://127.0.0.1:PORT/v1"`.
// Match top-level "model:" mapping block; does NOT match the `model: ""` sentinel.
const LEGACY_MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

/** @param {string} yaml */
export function parseLegacyModelBlock(yaml) {
  const match = (yaml || "").match(LEGACY_MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? m[1].trim() : null;
  };
  return { default: get("default"), provider: get("provider"), base_url: get("base_url") };
}

/** @param {string} yaml */
export const removeLegacyModelBlock = (yaml) =>
  (yaml || "").replace(LEGACY_MODEL_BLOCK_RE, "").replace(/^\n+/, "");

// Local-endpoint detection for the legacy block only — the custom_providers
// shape is recognised by provider name/reference and covers tunnel endpoints.
export const hasLegacySwitchboardModel = (modelCfg) => {
  if (!modelCfg?.base_url) return false;
  return modelCfg.provider === "custom" && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(modelCfg.base_url);
};

// ── stt ───────────────────────────────────────────────────────────────────────
// The api_key reference is the fingerprint — a user's own OpenAI audio setup
// keeps their own key, while ours always points at the SWITCHBOARD_API_KEY line
// we upsert in .env. base_url may be a tunnel URL, so no localhost test here.
export const isSwitchboardStt = (cfg) =>
  cfg?.provider === "openai" && !!cfg?.base_url && cfg?.api_key === HERMES_STT_API_KEY_REF;

// ── .env helpers — upsert/remove single KEY=VALUE line ────────────────────────
// The value is JSON-quoted so secrets containing spaces, quotes or shell
// metacharacters can never break out of the assignment.
export const upsertEnvVar = (envText, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${JSON.stringify(String(value))}`;
  if (re.test(envText)) return envText.replace(re, line);
  return envText.length > 0 && !envText.endsWith("\n") ? `${envText}\n${line}\n` : `${envText}${line}\n`;
};

export const removeEnvVar = (envText, key) => {
  const re = new RegExp(`^${key}=.*\\r?\\n?`, "m");
  return envText.replace(re, "");
};

// ── settings reading ──────────────────────────────────────────────────────────

/** @param {unknown} value */
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

const pickModelFields = (cfg) =>
  cfg ? { model: cfg.model ?? null, provider: cfg.provider ?? null, base_url: cfg.base_url ?? null } : null;

/**
 * Read every Switchboard-relevant section from a Hermes config.yaml.
 * Never throws — an unparsable file reads as unconfigured.
 *
 * @param {string} yamlText
 * @returns {{
 *   model: { default: string|null, provider: string|null, base_url: string|null } | null,
 *   models: string[],
 *   defaultModel: string|null,
 *   delegation: { model: string|null, provider: string|null, base_url: string|null } | null,
 *   auxiliary: Record<string, { model: string|null, provider: string|null, base_url: string|null }>,
 *   stt: { enabled: unknown, provider: string|null, model: string|null, base_url: string|null, api_key: string|null } | null,
 *   hasSwitchboard: boolean,
 *   hasSwitchboardStt: boolean,
 * }}
 */
export function readHermesSettings(yamlText) {
  const text = typeof yamlText === "string" ? yamlText : "";
  let parsed = {};
  try {
    parsed = parseYaml(text) || {};
  } catch {
    parsed = {}; // unparsable → treat as unconfigured
  }
  const root = asObject(parsed) || {};

  const providers = Array.isArray(root.custom_providers) ? root.custom_providers : [];
  const provider = providers.find((entry) => asObject(entry)?.name === HERMES_PROVIDER_NAME) || null;
  const providerModels = provider ? asObject(provider.models) : null;
  const catalogModels = providerModels ? Object.keys(providerModels) : [];

  // Managed docs carry the provider reference in model.provider; the legacy
  // fallback only fires when there is no `model:` mapping at all.
  const rawModel = asObject(root.model);
  const model = rawModel
    ? {
      default: typeof rawModel.default === "string" ? rawModel.default : null,
      provider: typeof rawModel.provider === "string" ? rawModel.provider : null,
      base_url: rawModel.base_url ?? null,
    }
    : parseLegacyModelBlock(text);

  const delegation = pickModelFields(asObject(root.delegation));

  const auxiliary = {};
  for (const [role, cfg] of Object.entries(asObject(root.auxiliary) || {})) {
    if (asObject(cfg) && AUX_ROLE_KEY_RE.test(role)) auxiliary[role] = pickModelFields(cfg);
  }

  const sttSource = asObject(root.stt);
  const sttOpenai = sttSource ? asObject(sttSource.openai) : null;
  const stt = sttSource
    ? {
      enabled: sttSource.enabled ?? null,
      provider: typeof sttSource.provider === "string" ? sttSource.provider : null,
      // The openai sub-block is the backend our override targets; sibling
      // settings (language, local, ...) are ignored by this reader.
      model: typeof sttOpenai?.model === "string" ? sttOpenai.model : null,
      base_url: typeof sttOpenai?.base_url === "string" ? sttOpenai.base_url : null,
      api_key: typeof sttOpenai?.api_key === "string" ? sttOpenai.api_key : null,
    }
    : null;

  const hasSwitchboard = Boolean(provider)
    || model?.provider === HERMES_PROVIDER_REF
    || hasLegacySwitchboardModel(model);

  // base_url display: the provider entry owns the endpoint; only fall back to
  // whatever the block itself carries (legacy shape).
  const modelView = model
    ? { ...model, ...(provider && provider.base_url ? { base_url: provider.base_url } : {}) }
    : null;

  return {
    model: modelView,
    models: catalogModels,
    defaultModel: model?.default || null,
    delegation,
    auxiliary,
    stt,
    hasSwitchboard,
    hasSwitchboardStt: isSwitchboardStt(stt),
  };
}
