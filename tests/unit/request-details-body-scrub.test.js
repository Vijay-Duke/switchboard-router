import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ adapter: null }));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => state.adapter),
}));

function makeFakeAdapter({ failTransactions = 0 } = {}) {
  const store = {
    rows: [],
    failuresLeft: failTransactions,
  };
  const adapter = {
    store,
    run(sql, params) {
      if (/^INSERT INTO requestDetails/i.test(sql)) store.rows.push(JSON.parse(params[6]));
      return { changes: 1, lastInsertRowid: 1 };
    },
    get() {
      return undefined;
    },
    all() {
      return [];
    },
    exec() {},
    transaction(fn) {
      if (store.failuresLeft > 0) {
        store.failuresLeft -= 1;
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return fn();
    },
    close() {},
  };
  return adapter;
}

const {
  saveRequestDetail,
  flushPendingRequestDetails,
  flushRequestDetailsSync,
  sanitizeBody,
  REDACTED_BODY_VALUE,
} = await import("../../src/lib/db/repos/requestDetailsRepo.js");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  // Drain any leftovers so the 5s batch timer never leaks between tests.
  if (state.adapter) {
    state.adapter.store.failuresLeft = 0;
    flushRequestDetailsSync();
  }
  vi.restoreAllMocks();
});

describe("sanitizeBody (L12)", () => {
  it("strips secret-typed keys at any depth without mutating input", () => {
    const input = {
      model: "m",
      apiKey: "sk-live-123",
      nested: { headers: { Authorization: "Bearer abc", "x-api-key": "k" }, password: "pw" },
      list: [{ token: "t", keep: 1 }],
    };
    const out = sanitizeBody(input);
    expect(out.apiKey).toBe(REDACTED_BODY_VALUE);
    expect(out.nested.headers.Authorization).toBe(REDACTED_BODY_VALUE);
    expect(out.nested.password).toBe(REDACTED_BODY_VALUE);
    expect(out.list[0].token).toBe(REDACTED_BODY_VALUE);
    expect(out.list[0].keep).toBe(1);
    expect(out.model).toBe("m");
    expect(input.nested.password).toBe("pw");
  });

  it("matches key spellings case-insensitively and keeps token counts", () => {
    const out = sanitizeBody({
      API_KEY: "x",
      access_token: "y",
      clientSecret: "z",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(out.API_KEY).toBe(REDACTED_BODY_VALUE);
    expect(out.access_token).toBe(REDACTED_BODY_VALUE);
    expect(out.clientSecret).toBe(REDACTED_BODY_VALUE);
    expect(out.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("passes scalars and arrays through", () => {
    expect(sanitizeBody(null)).toBe(null);
    expect(sanitizeBody("Bearer abc")).toBe("Bearer abc");
    expect(sanitizeBody([1, "a"])).toEqual([1, "a"]);
  });
});

describe("stored bodies carry no secrets (L12)", () => {
  it("persists redacted bodies while keeping metadata and truncation", async () => {
    state.adapter = makeFakeAdapter();
    await saveRequestDetail({
      provider: "openai",
      model: "gpt-4.1",
      status: "success",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: {
        headers: { authorization: "Bearer sk-live-123", "content-type": "application/json" },
        messages: [{ role: "user", content: "hi" }],
      },
      providerRequest: { apiKey: "sk-live-123", model: "gpt-4.1" },
      providerResponse: { credentials: { token: "tok-abc" }, ok: true },
      response: { content: "hello", password: "hunter2" },
    });
    await saveRequestDetail({
      provider: "openai",
      model: "gpt-4.1",
      status: "success",
      response: { content: "hello", data: "x".repeat(20000) },
    });
    // Let the fire-and-forget adapter handle settle, then drain synchronously.
    await new Promise((r) => setImmediate(r));
    expect(flushRequestDetailsSync()).toBe(2);

    expect(state.adapter.store.rows).toHaveLength(2);
    const dumped = JSON.stringify(state.adapter.store.rows);
    expect(dumped).not.toContain("sk-live-123");
    expect(dumped).not.toContain("tok-abc");
    expect(dumped).not.toContain("hunter2");
    const stored = state.adapter.store.rows[0];
    expect(stored.provider).toBe("openai");
    expect(stored.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(stored.request.headers.authorization).toBeUndefined();
    expect(stored.request.headers["content-type"]).toBe("application/json");
    expect(stored.providerRequest.apiKey).toBe(REDACTED_BODY_VALUE);
    expect(stored.response.password).toBe(REDACTED_BODY_VALUE);
    expect(stored.response.content).toBe("hello");
    // Oversized fields still collapse to a truncated preview.
    expect(state.adapter.store.rows[1].response._truncated).toBe(true);
  });
});

describe("failed flush re-queues instead of dropping (L11)", () => {
  it("retries the spliced batch on the next flush", async () => {
    state.adapter = makeFakeAdapter({ failTransactions: 1 });
    await saveRequestDetail({ provider: "p", model: "m", status: "ok", request: { a: 1 } });
    await flushPendingRequestDetails();
    expect(console.error).toHaveBeenCalledWith(
      "[requestDetailsRepo] Batch write failed:",
      expect.any(Error)
    );
    expect(state.adapter.store.rows).toHaveLength(0);

    await flushPendingRequestDetails();
    expect(state.adapter.store.rows).toHaveLength(1);
    expect(state.adapter.store.rows[0].provider).toBe("p");
  });
});
