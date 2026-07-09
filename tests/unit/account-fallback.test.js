import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getQuotaCooldown,
  checkFallbackError,
  isAccountUnavailable,
  getEarliestRateLimitedUntil,
  formatRetryAfter,
  getModelLockKey,
  isModelLockActive,
  getEarliestModelLockUntil,
  buildModelLockUpdate,
  buildClearModelLocksUpdate,
  filterAvailableAccounts,
  resetAccountState,
  applyErrorState,
  MODEL_LOCK_ALL,
} from "../../open-sse/services/accountFallback.js";
import { BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const LONG_COOLDOWN = 2 * 60 * 1000;
const SHORT_COOLDOWN = 5 * 1000;
const iso = (ms) => new Date(ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getQuotaCooldown", () => {
  it.each([
    [0, BACKOFF_CONFIG.base],
    [1, BACKOFF_CONFIG.base],
    [2, BACKOFF_CONFIG.base * 2],
    [3, BACKOFF_CONFIG.base * 4],
  ])("level %i doubles from the base", (level, expected) => {
    expect(getQuotaCooldown(level)).toBe(expected);
  });

  it("saturates at the configured max instead of growing unbounded", () => {
    expect(getQuotaCooldown(BACKOFF_CONFIG.maxLevel)).toBe(BACKOFF_CONFIG.max);
    expect(getQuotaCooldown(9999)).toBe(BACKOFF_CONFIG.max);
  });
});

describe("checkFallbackError classification", () => {
  it.each([
    // [label, status, errorText, shouldFallback, cooldownMs]
    ["429 backs off and rotates", 429, "", true, BACKOFF_CONFIG.base],
    ["401 rotates on a long cooldown", 401, "", true, LONG_COOLDOWN],
    ["402 rotates on a long cooldown", 402, "", true, LONG_COOLDOWN],
    ["403 rotates on a long cooldown", 403, "", true, LONG_COOLDOWN],
    ["404 rotates on a long cooldown", 404, "", true, LONG_COOLDOWN],
    ["500 is transient", 500, "", true, TRANSIENT_COOLDOWN_MS],
    ["503 is transient", 503, "", true, TRANSIENT_COOLDOWN_MS],
    ["408 is transient, not a request bug", 408, "", true, TRANSIENT_COOLDOWN_MS],
    ["unknown 0 status is transient", 0, "", true, TRANSIENT_COOLDOWN_MS],
  ])("%s", (_l, status, text, shouldFallback, cooldownMs) => {
    expect(checkFallbackError(status, text)).toMatchObject({ shouldFallback, cooldownMs });
  });

  it.each([400, 405, 409, 422])(
    "does not rotate accounts on unmatched client error %i (rotating cannot fix a bad body)",
    (status) => {
      expect(checkFallbackError(status, "")).toEqual({ shouldFallback: false, cooldownMs: 0 });
    }
  );

  it.each([
    ["rate limit", true],
    ["Too Many Requests", true],
    ["quota exceeded", true],
    ["at capacity", true],
    ["Overloaded", true],
  ])("text rule %s triggers exponential backoff", (text) => {
    const out = checkFallbackError(200, text, 0);
    expect(out).toEqual({ shouldFallback: true, cooldownMs: BACKOFF_CONFIG.base, newBackoffLevel: 1 });
  });

  it.each([
    ["request not allowed", SHORT_COOLDOWN],
    ["improperly formed request", LONG_COOLDOWN],
  ])("request-shape bug %s cools down but does NOT rotate accounts", (text, cooldownMs) => {
    expect(checkFallbackError(500, text)).toEqual({ shouldFallback: false, cooldownMs });
  });

  it("no credentials rotates on a long cooldown", () => {
    expect(checkFallbackError(500, "No credentials")).toEqual({
      shouldFallback: true,
      cooldownMs: LONG_COOLDOWN,
    });
  });

  it("prefers a text rule over the status rule for the same error", () => {
    // 400 alone is non-retryable; the rate-limit text must win and back off.
    expect(checkFallbackError(400, "rate limit reached")).toMatchObject({
      shouldFallback: true,
      newBackoffLevel: 1,
    });
  });

  it("matches error text case-insensitively and accepts non-string bodies", () => {
    expect(checkFallbackError(200, { error: "RATE LIMIT" })).toMatchObject({ newBackoffLevel: 1 });
  });

  it("escalates the backoff level on repeated rate limits and caps it", () => {
    expect(checkFallbackError(429, "", 1).newBackoffLevel).toBe(2);
    // level 2 → incremented to 3 → base * 2^(3-1)
    expect(checkFallbackError(429, "", 2).cooldownMs).toBe(BACKOFF_CONFIG.base * 4);
    expect(checkFallbackError(429, "", BACKOFF_CONFIG.maxLevel).newBackoffLevel).toBe(
      BACKOFF_CONFIG.maxLevel
    );
  });
});

describe("cooldown windows", () => {
  it("treats a future timestamp as unavailable and a past one as available", () => {
    expect(isAccountUnavailable(iso(NOW + 1000))).toBe(true);
    expect(isAccountUnavailable(iso(NOW - 1000))).toBe(false);
    expect(isAccountUnavailable(null)).toBe(false);
  });

  it("picks the earliest still-active rate limit and ignores expired ones", () => {
    const accounts = [
      { rateLimitedUntil: iso(NOW - 5000) }, // expired
      { rateLimitedUntil: iso(NOW + 9000) },
      { rateLimitedUntil: iso(NOW + 3000) }, // earliest active
      { rateLimitedUntil: null },
    ];
    expect(getEarliestRateLimitedUntil(accounts)).toBe(iso(NOW + 3000));
  });

  it("returns null when every account is free", () => {
    expect(getEarliestRateLimitedUntil([{ rateLimitedUntil: iso(NOW - 1) }, {}])).toBeNull();
  });

  it.each([
    [0, "reset after 0s"],
    [-5000, "reset after 0s"],
    [30_000, "reset after 30s"],
    [150_000, "reset after 2m 30s"],
    [3_600_000, "reset after 1h"],
  ])("formats a %ims window", (deltaMs, expected) => {
    expect(formatRetryAfter(iso(NOW + deltaMs))).toBe(expected);
  });

  it("formats an empty string when there is no rate limit", () => {
    expect(formatRetryAfter(null)).toBe("");
  });
});

describe("model locks", () => {
  it("keys per model, and falls back to the account-wide key when no model is given", () => {
    expect(getModelLockKey("claude/opus")).toBe("modelLock_claude/opus");
    expect(getModelLockKey(null)).toBe(MODEL_LOCK_ALL);
  });

  it("an account-wide lock blocks every model", () => {
    const conn = { [MODEL_LOCK_ALL]: iso(NOW + 1000) };
    expect(isModelLockActive(conn, "claude/opus")).toBe(true);
    expect(isModelLockActive(conn, null)).toBe(true);
  });

  it("a per-model lock does not block a different model", () => {
    const conn = { "modelLock_claude/opus": iso(NOW + 1000) };
    expect(isModelLockActive(conn, "claude/opus")).toBe(true);
    expect(isModelLockActive(conn, "gemini/pro")).toBe(false);
  });

  it("an expired lock does not block", () => {
    expect(isModelLockActive({ "modelLock_a": iso(NOW - 1) }, "a")).toBe(false);
  });

  it("reports the earliest active lock and ignores expired ones", () => {
    const conn = {
      id: "c1",
      "modelLock_a": iso(NOW - 10_000),
      "modelLock_b": iso(NOW + 60_000),
      "modelLock_c": iso(NOW + 5_000),
    };
    expect(getEarliestModelLockUntil(conn)).toBe(iso(NOW + 5_000));
    expect(getEarliestModelLockUntil({ id: "c1" })).toBeNull();
    expect(getEarliestModelLockUntil(null)).toBeNull();
  });

  it("builds and clears lock fields without touching other connection fields", () => {
    expect(buildModelLockUpdate("m", 5000)).toEqual({ "modelLock_m": iso(NOW + 5000) });
    expect(buildClearModelLocksUpdate({ id: "c1", "modelLock_a": "x", "modelLock_b": "y" })).toEqual({
      "modelLock_a": null,
      "modelLock_b": null,
    });
  });
});

describe("filterAvailableAccounts", () => {
  const accounts = [
    { id: "free" },
    { id: "cooling", rateLimitedUntil: iso(NOW + 1000) },
    { id: "recovered", rateLimitedUntil: iso(NOW - 1000) },
  ];

  it("drops accounts still in cooldown and keeps recovered ones", () => {
    expect(filterAvailableAccounts(accounts).map((a) => a.id)).toEqual(["free", "recovered"]);
  });

  it("excludes the account that just failed", () => {
    expect(filterAvailableAccounts(accounts, "free").map((a) => a.id)).toEqual(["recovered"]);
  });

  it("can return nothing when every account is cooling", () => {
    expect(filterAvailableAccounts([accounts[1]])).toEqual([]);
  });
});

describe("account state transitions", () => {
  it("a 429 moves an active account into error with a backoff cooldown", () => {
    const errored = applyErrorState({ id: "a", backoffLevel: 0, status: "active" }, 429, "rate limit");

    expect(errored).toMatchObject({
      id: "a",
      status: "error",
      backoffLevel: 1,
      rateLimitedUntil: iso(NOW + BACKOFF_CONFIG.base),
    });
    expect(errored.lastError).toMatchObject({ status: 429, message: "rate limit" });
  });

  it("a repeated 429 escalates the backoff level and lengthens the cooldown", () => {
    const errored = applyErrorState({ id: "a", backoffLevel: 2 }, 429, "");
    expect(errored.backoffLevel).toBe(3);
    expect(errored.rateLimitedUntil).toBe(iso(NOW + BACKOFF_CONFIG.base * 4));
  });

  it("a non-retryable 400 records the error but sets no cooldown", () => {
    const errored = applyErrorState({ id: "a", backoffLevel: 0 }, 400, "bad tool schema");
    expect(errored.rateLimitedUntil).toBeNull();
    expect(errored.backoffLevel).toBe(0);
    expect(errored.status).toBe("error");
  });

  it("success clears the cooldown and the accumulated backoff", () => {
    const recovered = resetAccountState({
      id: "a",
      status: "error",
      backoffLevel: 4,
      rateLimitedUntil: iso(NOW + 60_000),
      lastError: { status: 429 },
    });

    expect(recovered).toMatchObject({
      id: "a",
      status: "active",
      backoffLevel: 0,
      rateLimitedUntil: null,
      lastError: null,
    });
  });

  it("error → recover → error restarts the backoff ladder from level 1", () => {
    let acc = { id: "a", backoffLevel: 0 };
    acc = applyErrorState(acc, 429, "");
    acc = applyErrorState(acc, 429, "");
    expect(acc.backoffLevel).toBe(2);

    acc = resetAccountState(acc);
    acc = applyErrorState(acc, 429, "");
    expect(acc.backoffLevel).toBe(1);
    expect(acc.rateLimitedUntil).toBe(iso(NOW + BACKOFF_CONFIG.base));
  });

  it("passes a nullish account straight through", () => {
    expect(applyErrorState(null, 429, "")).toBeNull();
    expect(resetAccountState(undefined)).toBeUndefined();
  });
});
