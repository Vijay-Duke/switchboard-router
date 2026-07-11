import { describe, it, expect, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

/**
 * Build a minimal Response stub with the .ok + .clone().json() surface combo.js uses.
 */
function okResponse(content) {
  const json = { choices: [{ message: { role: "assistant", content } }], usage: { completion_tokens: content ? content.split(" ").length : 0 } };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json, headers: new Map(), body: null });
  return make();
}

function emptyOkResponse() {
  // Empty content: completion_tokens would be 0, hasJsonCompletion returns false
  const json = { choices: [{ message: { role: "assistant", content: "" } }], usage: { completion_tokens: 0 } };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json, headers: new Map(), body: null });
  return make();
}

function noContentOkResponse() {
  // Response with no choices at all
  const json = { object: "chat.completion", choices: [] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json, headers: new Map(), body: null });
  return make();
}

function errResponse(status = 500, body = { error: { message: "boom" } }) {
  const make = () => ({ ok: false, status, clone: make, json: async () => body, headers: new Map(), body: null });
  return make();
}

describe("combo fallback", () => {
  it("returns first successful model response", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("hello"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("hello");
  });

  it("falls through empty 2xx response to next model", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(emptyOkResponse())
      .mockResolvedValueOnce(okResponse("fallback answer"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/empty", "p/fallback"],
      handleSingleModel,
      log,
    });
    // First model returned empty 2xx → should fall through to fallback
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("fallback answer");
  });

  it("falls through no-content 2xx response to next model", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(noContentOkResponse())
      .mockResolvedValueOnce(okResponse("backup answer"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/nochoice", "p/backup"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("backup answer");
  });

  it("retries transient 503 once after cooldown before falling through", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(errResponse(503, { error: { message: "overloaded" } }))
      .mockResolvedValueOnce(okResponse("retry succeeded"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],       // only 2 models; first retry hits p/a again
      handleSingleModel,
      log,
    });
    // First call to p/a → transient 503 → cooldown → retry p/a → succeeds
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    // Both calls targeted the same model (p/a)
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/a");
    expect(handleSingleModel.mock.calls[1][1]).toBe("p/a");
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("retry succeeded");
  });

  it("passes through to next model when retry also fails", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(errResponse(503, { error: { message: "overloaded" } }))
      .mockResolvedValueOnce(errResponse(503, { error: { message: "still overloaded" } }))
      .mockResolvedValueOnce(okResponse("third time's the charm"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],       // 2 models: p/a retry → fail → p/b → success
      handleSingleModel,
      log,
    });
    // p/a → transient 503 → cooldown → retry p/a (again 503) → p/b → ok
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/a");
    expect(handleSingleModel.mock.calls[1][1]).toBe("p/a");
    expect(handleSingleModel.mock.calls[2][1]).toBe("p/b");
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("third time's the charm");
  });

  it("does not retry non-transient errors", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(errResponse(500, { error: { message: "internal" } }))
      .mockResolvedValueOnce(okResponse("second model works"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });
    // 500 is not transient → no retry → straight to p/b
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/a");
    expect(handleSingleModel.mock.calls[1][1]).toBe("p/b");
    expect(res.ok).toBe(true);
  });

  it("returns 503 when all models fail with transient errors", async () => {
    // 503 triggers the transient+retry path and also sets lastStatus
    const handleSingleModel = vi.fn(async () => errResponse(503, { error: { message: "overloaded" } }));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.message).toContain("retry");
  });

  it("returns last error status when all models fail", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500, { error: { message: "internal error" } }));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.message).toContain("internal error");
  });

  it("returns 503 when all models return empty 2xx", async () => {
    const handleSingleModel = vi.fn(async () => emptyOkResponse());
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });
    expect(res.status).toBe(503);
  });
});
