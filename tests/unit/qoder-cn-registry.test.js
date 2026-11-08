/**
 * Qoder CN provider wiring.
 *
 * The qoder-cn registry entry must produce a fully-routed provider: CN gateway
 * transport, qdcn alias, shared capability table, and a CN-region executor
 * (queue/signing/model-list all branch on the region).
 */
import { describe, it, expect } from "vitest";

import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "../../open-sse/config/providerModels.js";
import { PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

describe("qoder-cn provider wiring", () => {
  it("registers a CN-region executor", () => {
    expect(getExecutor("qoder-cn")).toBeDefined();
    expect(getExecutor("qoder-cn").region).toBe("cn");
    expect(getExecutor("qoder").region).toBe("intl");
  });

  it("serves the CN gateway baseUrl with the openai-node identity", () => {
    expect(PROVIDERS["qoder-cn"].baseUrl).toContain("gateway.qoder.com.cn");
    expect(PROVIDERS["qoder-cn"].identity).toBe("openai-node");
  });

  it("exposes the qdcn alias and static model catalog", () => {
    expect(PROVIDER_ID_TO_ALIAS["qoder-cn"]).toBe("qdcn");
    const models = PROVIDER_MODELS["qdcn"] || PROVIDER_MODELS["qoder-cn"];
    expect(Array.isArray(models)).toBe(true);
    expect(models.some((m) => m.id === "auto")).toBe(true);
    expect(models.some((m) => m.id === "smodel")).toBe(true);
  });

  it("shares the intl Qoder capability table", () => {
    expect(PROVIDER_CAPABILITIES["qoder-cn"]).toBe(PROVIDER_CAPABILITIES["qoder"]);
  });
});
