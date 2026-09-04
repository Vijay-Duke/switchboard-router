import { describe, it, expect, afterEach } from "vitest";

import { AzureExecutor } from "../../open-sse/executors/azure.js";

const ENV_KEYS = ["AZURE_API_KEY", "OPENAI_API_KEY"];
const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("azure credentials (E3)", () => {
  it("sends the connection apiKey as the Azure api-key header", () => {
    delete process.env.AZURE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const ex = new AzureExecutor();
    const headers = ex.buildHeaders({ apiKey: "az-key" });
    expect(headers["api-key"]).toBe("az-key");
  });

  it("falls back to AZURE_API_KEY (provider-correct env)", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.AZURE_API_KEY = "az-env-key";
    const ex = new AzureExecutor();
    expect(ex.buildHeaders({})["api-key"]).toBe("az-env-key");
  });

  it("never sends another provider's OPENAI_API_KEY to Azure", () => {
    delete process.env.AZURE_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai";
    const ex = new AzureExecutor();
    expect(ex.buildHeaders({})["api-key"]).toBeUndefined();
  });
});
