import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

import blackForestLabs from "../../open-sse/handlers/imageProviders/blackForestLabs.js";
import falAi from "../../open-sse/handlers/imageProviders/falAi.js";
import nanobanana from "../../open-sse/handlers/imageProviders/nanobanana.js";
import runwayml from "../../open-sse/handlers/imageProviders/runwayml.js";

beforeEach(() => {
  vi.useFakeTimers();
  proxyAwareFetch.mockReset();
});
afterEach(() => vi.useRealTimers());

async function completePoll(parseResponse, submitResponse, pollResponses) {

  proxyAwareFetch.mockImplementation(async () => pollResponses.shift());
  const pending = parseResponse(submitResponse, {
    headers: { Authorization: "Bearer key", "x-key": "key" },
  });
  await vi.advanceTimersByTimeAsync(1500);
  return pending;
}

describe("authenticated image polling identity", () => {
  it("applies the BFL registry profile to polling", async () => {
    await completePoll(
      blackForestLabs.parseResponse,
      Response.json({ polling_url: "https://api.bfl.ai/v1/get_result?id=1" }),
      [Response.json({ status: "Ready", result: { sample: "https://example.com/a.png" } })],
    );
    expect(proxyAwareFetch).toHaveBeenCalledWith(expect.stringContaining("api.bfl.ai"), expect.objectContaining({
      identity: "openai-node", provider: "black-forest-labs", format: "openai",
    }));
  });

  it("applies the Fal registry profile to status and response fetches", async () => {
    await completePoll(
      falAi.parseResponse,
      Response.json({ status_url: "https://queue.fal.run/status", response_url: "https://queue.fal.run/result" }),
      [Response.json({ status: "COMPLETED" }), Response.json({ images: [] })],
    );
    expect(proxyAwareFetch).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({
      identity: "openai-node", provider: "fal-ai", format: "openai",
    }));
    expect(proxyAwareFetch).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      identity: "openai-node", provider: "fal-ai", format: "openai",
    }));
  });

  it("applies the NanoBanana registry profile to polling", async () => {
    await completePoll(
      nanobanana.parseResponse,
      Response.json({ code: 200, data: { taskId: "task-1" } }),
      [Response.json({ data: { successFlag: 1, response: {} } })],
    );
    expect(proxyAwareFetch).toHaveBeenCalledWith(expect.stringContaining("record-info"), expect.objectContaining({
      identity: "openai-node", provider: "nanobanana", format: "openai",
    }));
  });

  it("applies the Runway registry profile to polling", async () => {
    await completePoll(
      runwayml.parseResponse,
      Response.json({ id: "task-1" }),
      [Response.json({ status: "SUCCEEDED", output: [] })],
    );
    expect(proxyAwareFetch).toHaveBeenCalledWith(expect.stringContaining("/tasks/task-1"), expect.objectContaining({
      identity: "openai-node", provider: "runwayml", format: "openai",
    }));
  });
});
