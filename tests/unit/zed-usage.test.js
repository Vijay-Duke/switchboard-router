import { describe, it, expect, vi, beforeEach } from "vitest";

// proxyAwareFetch captures globalThis.fetch at import time — mock the module
// (pattern from glm-usage.test.js) so the users/me fetch stays local.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
  default: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  formatZedPlanLabel,
  parseZedUsageLimit,
  parseZedAuthenticatedUserUsage,
  getZedUsage,
} from "../../open-sse/services/usage/zed.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";

function usersMeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function proUserBody({ modelLimit = null } = {}) {
  return {
    email: "z@zed.dev",
    default_organization_id: "org-1",
    plan: {
      plan_v3: "zed_pro",
      subscription_period: { ended_at: "2099-01-01T00:00:00Z" },
      usage: {
        edit_predictions: { used: 40, limit: "unlimited" },
        model_requests: { used: 12, limit: modelLimit ?? 500 },
      },
    },
  };
}

beforeEach(() => {
  vi.mocked(proxyAwareFetch).mockReset();
});

describe("zed usage dispatch", () => {
  it("is a usage-supported provider with a handler entry", async () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("zed");
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(usersMeResponse(proUserBody()));
    const out = await getUsageForProvider({
      provider: "zed",
      accessToken: "tok",
      providerSpecificData: { userId: "u1" },
    });
    expect(out.plan).toBe("Zed Pro");
    expect(out.quotas["Edit Predictions"]).toBeDefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("passes proxy options through to the cloud fetch", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(usersMeResponse(proUserBody()));
    await getUsageForProvider(
      { provider: "zed", accessToken: "tok", providerSpecificData: { userId: "u1" } },
      { proxyUrl: "http://127.0.0.1:7890" },
    );
    const args = vi.mocked(proxyAwareFetch).mock.calls[0];
    expect(args[2]).toEqual({ proxyUrl: "http://127.0.0.1:7890" });
  });
});

describe("formatZedPlanLabel", () => {
  it("maps known plan ids to labels", () => {
    expect(formatZedPlanLabel("zed_free")).toBe("Zed Free");
    expect(formatZedPlanLabel("zed_pro")).toBe("Zed Pro");
    expect(formatZedPlanLabel("zed_pro_trial")).toBe("Zed Pro Trial");
    expect(formatZedPlanLabel("zed_student")).toBe("Zed Student");
    expect(formatZedPlanLabel("zed_business")).toBe("Zed Business");
  });

  it("title-cases unknown ids and defaults to Zed", () => {
    expect(formatZedPlanLabel("custom_team_plan")).toBe("Custom Team Plan");
    expect(formatZedPlanLabel("")).toBe("Zed");
    expect(formatZedPlanLabel(null)).toBe("Zed");
  });
});

describe("parseZedUsageLimit", () => {
  it("parses unlimited markers", () => {
    expect(parseZedUsageLimit("unlimited")).toEqual({ unlimited: true, total: 0 });
    expect(parseZedUsageLimit({ unlimited: true })).toEqual({ unlimited: true, total: 0 });
  });

  it("parses numeric and { limited } shapes", () => {
    expect(parseZedUsageLimit(500)).toEqual({ unlimited: false, total: 500 });
    expect(parseZedUsageLimit({ limited: 25 })).toEqual({ unlimited: false, total: 25 });
    expect(parseZedUsageLimit("42")).toEqual({ unlimited: false, total: 42 });
  });

  it("treats { limited: 0 } as a zero cap (token-billed)", () => {
    expect(parseZedUsageLimit({ limited: 0 })).toEqual({ unlimited: false, total: 0 });
  });
});

describe("parseZedAuthenticatedUserUsage", () => {
  it("derives quota rows from plan.usage", () => {
    const parsed = parseZedAuthenticatedUserUsage(proUserBody({ modelLimit: 500 }));
    expect(parsed.plan).toBe("Zed Pro");
    expect(parsed.planId).toBe("zed_pro");
    expect(parsed.resetAt).toBeTruthy();

    const edit = parsed.quotas["Edit Predictions"];
    expect(edit).toMatchObject({ used: 40, total: 0, unlimited: true, remainingPercentage: 100 });

    const models = parsed.quotas["Hosted Model Requests"];
    expect(models).toMatchObject({ used: 12, total: 500, unlimited: false });
    expect(models.remainingPercentage).toBeGreaterThan(0);
    expect(parsed.message).toBeNull();
  });

  it("drops the requests row when token-billed (limit 0)", () => {
    const parsed = parseZedAuthenticatedUserUsage(proUserBody({ modelLimit: { limited: 0 } }));
    expect(parsed.quotas["Hosted Model Requests"]).toBeUndefined();
    expect(parsed.quotas["Edit Predictions"]).toBeDefined();
    expect(parsed.message).toMatch(/billed per token/i);
  });

  it("flags overdue invoices with a blocking message", () => {
    const body = proUserBody();
    body.plan.has_overdue_invoices = true;
    const parsed = parseZedAuthenticatedUserUsage(body);
    expect(parsed.hasOverdueInvoices).toBe(true);
    expect(parsed.message).toMatch(/overdue invoices/i);
  });

  it("annotates trial plans", () => {
    const body = proUserBody();
    body.plan.trial_started_at = "2026-01-01T00:00:00Z";
    const parsed = parseZedAuthenticatedUserUsage(body);
    expect(parsed.trialStarted).toBe(true);
    expect(parsed.plan).toMatch(/\(Trial active\)/);
  });

  it("handles camelCase / plan_v2 shapes", () => {
    const parsed = parseZedAuthenticatedUserUsage({
      plan: {
        plan_v2: "zed_pro",
        subscriptionPeriod: { endedAt: "2099-01-01T00:00:00Z" },
        usage: {
          editPredictions: { used: 1, limit: 10 },
        },
      },
    });
    expect(parsed.planId).toBe("zed_pro");
    expect(parsed.quotas["Edit Predictions"]).toMatchObject({ used: 1, total: 10 });
  });
});

describe("getZedUsage", () => {
  it("sends the '<userId> <token>' auth header", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(usersMeResponse(proUserBody()));
    await getZedUsage("tok", { userId: "u9" }, null);
    const [, options] = vi.mocked(proxyAwareFetch).mock.calls[0];
    expect(options.headers.Authorization).toBe("u9 tok");
  });

  it("requires accessToken and userId", async () => {
    await expect(getZedUsage(null, { userId: "u1" })).resolves.toMatchObject({
      message: expect.stringContaining("access token"),
    });
    await expect(getZedUsage("tok", {})).resolves.toMatchObject({
      message: expect.stringContaining("user id"),
    });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns a re-auth message on 401/403", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(
      usersMeResponse({ message: "nope" }, 401),
    );
    const out = await getZedUsage("tok", { userId: "u1" }, null);
    expect(out.message).toMatch(/sign in again/i);
    expect(out.quotas).toBeUndefined();
  });

  it("surfaces other errors as a message", async () => {
    vi.mocked(proxyAwareFetch).mockRejectedValueOnce(new Error("boom"));
    const out = await getZedUsage("tok", { userId: "u1" }, null);
    expect(out.message).toBe("Zed error: boom");
  });
});
