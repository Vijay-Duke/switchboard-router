import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: vi.fn() }));
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials: vi.fn() }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: vi.fn() }));
vi.mock("../../src/sse/services/connectionInFlight.js", () => ({ withConnectionInFlight: vi.fn((_info, work) => work()) }));
vi.mock("../../open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: vi.fn() }));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({ settleUsageStats: vi.fn() }));

import { getModelInfo } from "../../src/sse/services/model.js";
import { getProviderCredentials } from "../../src/sse/services/auth.js";
import { checkAndRefreshToken } from "../../src/sse/services/tokenRefresh.js";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";
import { settleUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { resolveSmartChoice } from "../../src/sse/services/systemoneRouter.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const models = ["test/first", "test/better"];
const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "write code" }] }] };
const opts = { body, models, clientKeyId: "key-1", routerModel: "oll/clef", log };

beforeEach(() => {
  vi.clearAllMocks();
  getModelInfo.mockResolvedValue({ provider: "ollama", model: "clef" });
  getProviderCredentials.mockResolvedValue({ apiKey: "secret", connectionId: "connection-1" });
  checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  handleSystemoneCore.mockImplementation(async () => ({ success: true,
    usage: { prompt_tokens: 10, completion_tokens: 2 },
    response: Response.json({ answers: { route: { choice: models[1], confidence: 0.99 } } }),
  }));
});
afterEach(() => vi.useRealTimers());

describe("System One dispatch", () => {
  it("connects combo classification to the configured model, key, usage and chosen worker", async () => {
    const handleSingleModel = vi.fn(async () => Response.json({ choices: [{ message: { content: "ok" } }] }));
    const response = await handleComboChat({ body, models, handleSingleModel, log, comboName: "test",
      comboStrategy: "smart", sessionSticky: false,
      resolveSmartChoice: (routerBody, candidates) => resolveSmartChoice({ ...opts, body: routerBody, models: candidates }),
    });
    expect(response.status).toBe(200);
    expect(getModelInfo).toHaveBeenCalledWith("oll/clef");
    expect(getProviderCredentials).toHaveBeenCalledWith("ollama", expect.any(Set), "clef", { clientKeyId: "key-1" });
    expect(handleSystemoneCore.mock.calls[0][0].body.state).toBe("write code");
    expect(handleSingleModel.mock.calls[0][1]).toBe(models[1]);
    expect(settleUsageStats).toHaveBeenCalledWith(expect.objectContaining({ clientKeyId: "key-1", tokens: { prompt_tokens: 10, completion_tokens: 2 } }));
  });

  it("aborts the upstream fetch on classifier timeout and falls back", async () => {
    vi.useFakeTimers();
    let signal;
    handleSystemoneCore.mockImplementation(({ abortSignal }) => {
      signal = abortSignal;
      return new Promise(resolve => abortSignal.addEventListener("abort", () => resolve({ success: false, status: 499 }), { once: true }));
    });
    const pending = resolveSmartChoice({ ...opts, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBeNull();
    expect(signal.aborted).toBe(true);
  });

  it("starts no upstream work when the caller has disconnected", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await resolveSmartChoice({ ...opts, abortSignal: controller.signal })).toBeNull();
    expect(handleSystemoneCore).not.toHaveBeenCalled();
  });
});
