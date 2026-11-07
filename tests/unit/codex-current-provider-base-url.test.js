import { describe, expect, it } from "vitest";

import { getCurrentCodexProviderSettings } from "../../src/app/(dashboard)/dashboard/cli-tools/components/codexConfig.js";

describe("getCurrentCodexProviderSettings", () => {
  it("reads base_url and bearer key from the active provider only", () => {
    const config = [
      'model = "sw/model-a"',
      'model_provider = "switchboard"',
      "",
      "[model_providers.other]",
      'base_url = "https://other.example/v1"',
      "",
      "[model_providers.other.http_headers]",
      'Authorization = "Bearer other-key"',
      "",
      "[model_providers.switchboard]",
      'name = "Switchboard"',
      'base_url = "http://127.0.0.1:20128/v1" # local',
      "",
      "[model_providers.switchboard.http_headers]",
      'Authorization = "Bearer sk_switchboard"',
      "",
    ].join("\n");

    expect(getCurrentCodexProviderSettings(config)).toEqual({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_switchboard",
    });
  });

  it("returns empty values when no provider is active or input is not a string", () => {
    expect(getCurrentCodexProviderSettings('[model_providers.switchboard]\nbase_url = "x"\n'))
      .toEqual({ baseUrl: "", apiKey: "" });
    expect(getCurrentCodexProviderSettings(null)).toEqual({ baseUrl: "", apiKey: "" });
  });

  it("ignores model_provider keys that live inside a table", () => {
    const config = '[profiles.x]\nmodel_provider = "other"\n';
    expect(getCurrentCodexProviderSettings(config)).toEqual({ baseUrl: "", apiKey: "" });
  });
});

describe("getCurrentCodexProviderSettings with an explicit provider", () => {
  it("reads the named table even when another provider is active", () => {
    const config = [
      'model_provider = "other"',
      "[model_providers.other]",
      'base_url = "https://other.example/v1"',
      "[model_providers.switchboard]",
      'base_url = "http://127.0.0.1:20128/v1"',
      "[model_providers.switchboard.http_headers]",
      'Authorization = "Bearer sk_x"',
    ].join("\n");
    expect(getCurrentCodexProviderSettings(config, "switchboard")).toEqual({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_x",
    });
  });
});
