import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// Ported from upstream b82f5c4a (the checkFallbackError cases lived in an
// upstream-only account-fallback-4xx.test.js).
describe("checkFallbackError credit exhaustion", () => {
  it.each([
    "You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
    "INSUFFICIENT CREDITS",
    "Insufficient credit balance",
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    "CREDIT BALANCE IS TOO LOW",
  ])("falls back with backoff for a 400 credit error: %s", (message) => {
    expect(checkFallbackError(400, message)).toEqual({ shouldFallback: true, cooldownMs: 2000, newBackoffLevel: 1 });
    expect(checkFallbackError(400, message, 1)).toEqual({ shouldFallback: true, cooldownMs: 4000, newBackoffLevel: 2 });
  });

  it("does not fall back for an ordinary bad request", () => {
    expect(checkFallbackError(400, "Bad request")).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });
});

describe("combo credit fallback", () => {
  it.each([
    ["You have insufficient credits to make this request.", true],
    ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", true],
    ["Bad request", false],
  ])("routes a 400 response correctly: %s", async (message, shouldContinue) => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const failure = Response.json({ error: { message } }, { status: 400 });
    const success = Response.json({ choices: [{ message: { content: "Hello" } }] });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({
      body, models, handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback", comboStrategy: "fallback",
    });

    expect(response).toBe(shouldContinue ? success : failure);
    // Switchboard passes a third call-options arg (signal/depth); compare the first two.
    expect(handleSingleModel.mock.calls.map(([b, m]) => [b, m])).toEqual(
      (shouldContinue ? models : models.slice(0, 1)).map((model) => [body, model])
    );
  });
});
