import { describe, expect, it } from "vitest";
import {
  beginClaudeToolOperation,
  buildClaudeCatalogDraftFingerprint,
  buildClaudeSettingsMutation,
  finishClaudeToolOperation,
  isClaudeToolOperationCurrent,
  readClaudeModelMappings,
  requestClaudePickerLabels,
} from "../../src/app/(dashboard)/dashboard/cli-tools/components/claudeSettingsForm.js";

const models = [
  { alias: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", defaultValue: "cc/claude-opus-4-8" },
  { alias: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL", defaultValue: "cc/claude-sonnet-5" },
];

describe("Claude Code settings form", () => {
  it("detects meaningful full-catalog draft changes", () => {
    const saved = buildClaudeCatalogDraftFingerprint({
      baseUrl: "http://127.0.0.1:20128/v1/",
      models: ["kr/claude-opus-4-8"],
      pickerLabels: { "kr/claude-opus-4-8": "KR Opus" },
    });

    expect(buildClaudeCatalogDraftFingerprint({
      baseUrl: "http://127.0.0.1:20128/v1",
      models: ["kr/claude-opus-4-8"],
      pickerLabels: { "kr/claude-opus-4-8": "KR Opus" },
    })).toBe(saved);
    expect(buildClaudeCatalogDraftFingerprint({
      baseUrl: "http://127.0.0.1:20128/v1",
      models: ["kr/claude-opus-4-8"],
      pickerLabels: { "kr/claude-opus-4-8": "KR Opus APAC" },
    })).not.toBe(saved);
  });

  it("generates labels in batches without exposing the request limit", async () => {
    const modelIds = Array.from({ length: 81 }, (_, index) => `kr/model-${index + 1}`);
    const batchSizes = [];
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      batchSizes.push(body.modelIds.length);
      return new Response(JSON.stringify({
        source: "ai",
        labels: Object.fromEntries(body.modelIds.map((modelId) => [modelId, `Label ${modelId}`])),
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await requestClaudePickerLabels({ modelIds, fetchImpl });

    expect(batchSizes).toEqual([40, 40, 1]);
    expect(Object.keys(result.labels)).toEqual(modelIds);
    expect(result.source).toBe("ai");
  });

  it("shows restored file values instead of substituting cc/* defaults", () => {
    expect(readClaudeModelMappings(models, {
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/previous-opus" },
    })).toEqual({
      opus: "anthropic/previous-opus",
      sonnet: "",
    });
  });

  it("leaves model fields empty when the file has no model overrides", () => {
    expect(readClaudeModelMappings(models, { env: {} })).toEqual({
      opus: "",
      sonnet: "",
    });
  });

  it("keeps native OAuth in pass-through mode and authenticates Switchboard separately", () => {
    expect(buildClaudeSettingsMutation({
      baseUrl: "http://127.0.0.1:20128/v1",
      gatewayKey: "sk-test",
      models,
      modelMappings: { opus: "", sonnet: "claude-switchboard-gpt" },
    })).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Switchboard-Key: sk-test\nX-Switchboard-Claude-Mode: pass-through",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-switchboard-gpt",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Switchboard · claude-switchboard-gpt",
        ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: "Sonnet slot routes through Switchboard to claude-switchboard-gpt",
      },
      removeEnvKeys: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_CUSTOM_MODEL_OPTION",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
      ],
    });
  });

  it("builds a separate full-catalog profile without subscription pass-through", async () => {
    const {
      buildClaudeFullCatalogProfile,
      readClaudeCatalogSelectionFromCustomHeaders,
    } = await import("../../src/shared/claudeGateway.js");

    const profile = buildClaudeFullCatalogProfile({
      baseUrl: "http://127.0.0.1:20128/",
      gatewayKey: "sk-test",
      models: ["openai/gpt-5.6", "coding-auto", "openai/gpt-5.6"],
      pickerLabels: { "openai/gpt-5.6": "GPT 5.6" },
    });

    expect(profile.env).toMatchObject({
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "sk-test",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
      ANTHROPIC_CUSTOM_HEADERS: expect.stringContaining("X-Switchboard-Claude-Mode: full-catalog"),
      ANTHROPIC_CUSTOM_MODEL_OPTION: "",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
    });
    expect(readClaudeCatalogSelectionFromCustomHeaders(
      profile.env.ANTHROPIC_CUSTOM_HEADERS,
    )).toEqual(["openai/gpt-5.6", "coding-auto"]);
    expect(profile.pickerLabels).toEqual({
      "openai/gpt-5.6": "GPT 5.6",
    });
  });

  it("clears stale custom picker state when pass-through has no custom model", () => {
    expect(buildClaudeSettingsMutation({
      baseUrl: "http://127.0.0.1:20128/v1",
      gatewayKey: "sk-test",
      models: [],
      modelMappings: {},
    })).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Switchboard-Key: sk-test\nX-Switchboard-Claude-Mode: pass-through",
      },
      removeEnvKeys: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_CUSTOM_MODEL_OPTION",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
      ],
    });
  });

  it("serializes Apply and Disconnect and rejects stale completion tokens", () => {
    const ref = { current: { kind: "idle", generation: 0 } };
    const applyToken = beginClaudeToolOperation(ref, "apply");

    expect(applyToken).toEqual({ kind: "apply", generation: 1 });
    expect(beginClaudeToolOperation(ref, "disconnect")).toBeNull();
    expect(isClaudeToolOperationCurrent(ref, applyToken)).toBe(true);
    expect(finishClaudeToolOperation(ref, applyToken)).toBe(true);

    const disconnectToken = beginClaudeToolOperation(ref, "disconnect");
    expect(disconnectToken).toEqual({ kind: "disconnect", generation: 2 });
    expect(isClaudeToolOperationCurrent(ref, applyToken)).toBe(false);
    expect(finishClaudeToolOperation(ref, applyToken)).toBe(false);
    expect(isClaudeToolOperationCurrent(ref, disconnectToken)).toBe(true);
  });
});
