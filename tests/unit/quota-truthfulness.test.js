// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, h } from "./dashboard-dom-harness.js";
import { quotaNumber, quotaRemainingPercent } from "../../open-sse/services/usage/quotaValidity.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import QuotaTable from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js";
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";

const harness = createHarness();
const response = data => Response.json(data);
beforeEach(() => proxyAwareFetch.mockReset());
afterEach(() => { harness.unmount(); vi.useRealTimers(); });

describe("quota observations remain truthful", () => {
  it.each([null, undefined, "", " ", false, true, Infinity, NaN])("does not turn missing or invalid %s into usage", value => {
    expect(quotaNumber(value)).toBeNull();
    expect(quotaRemainingPercent({ used: value, total: 100 })).toBeNull();
  });
  it("distinguishes absolute credits, provider percent, and actual zero usage", () => {
    expect(quotaRemainingPercent({ used: 200, total: 1000, remaining: 800 })).toBe(80);
    expect(quotaRemainingPercent({ remaining: 800, total: 1000 })).toBe(80);
    expect(quotaRemainingPercent({ remaining: 800 })).toBeNull();
    expect(quotaRemainingPercent({ used: 0, total: 100 })).toBe(100);
  });
  it("renders stale and expired windows without green availability", async () => {
    const quotas = parseQuotaData("claude", { stale: true, quotas: {
      session: { used: 10, total: 100, resetAt: new Date(Date.now() - 60000).toISOString() },
      weekly: { used: 97, total: 100, resetAt: new Date(Date.now() - 3600000).toISOString() },
    }});
    const element = await harness.mount(h(QuotaTable, { quotas, compact: true }));
    expect(element.textContent).toContain("Unknown");
    expect(element.textContent).not.toMatch(/90%|3%|Today/);
    expect(element.querySelector(".bg-green-500")).toBeNull();
  });
  it("expires a row while the page is open, without another provider fetch", async () => {
    vi.useFakeTimers();
    const quotas = parseQuotaData("claude", { observedAt: new Date().toISOString(), quotas: {
      session: { used: 10, total: 100, resetAt: new Date(Date.now() + 10000).toISOString() },
    }});
    const element = await harness.mount(h(QuotaTable, { quotas }));
    expect(element.textContent).toContain("90% remaining");
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(element.textContent).not.toContain("90%");
    expect(element.textContent).toContain("Reset passed; refresh needed");
  });
  it("shows a known credit balance without inventing an allowance or unlimited access", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "30.04" }] }));
    const result = await getUsageForProvider({ provider: "deepseek", apiKey: "synthetic-key" });
    const element = await harness.mount(h(QuotaTable, { quotas: parseQuotaData("deepseek", result) }));
    expect(element.textContent).toContain("30.04 USD available");
    expect(element.textContent).not.toMatch(/100%|Unlimited|∞/);
  });
  it.each([
    ["codex", { rate_limit: { primary_window: { reset_at: 2000000000 } } }],
    ["kimi", { usage: { limit: 100 }, limits: [{ detail: { limit: 60 } }] }],
    ["kiro", { usageBreakdownList: [{ resourceType: "credits", usageLimitWithPrecision: 100 }] }],
    ["github", { quota_snapshots: { chat: { entitlement: 100 } } }],
    ["minimax", { model_remains: [{ model_name: "general", current_interval_total_count: 100 }], base_resp: { status_code: 0 } }],
    ["glm", { data: { limits: [{ type: "TOKENS_LIMIT" }] } }],
    ["qoder", { userQuota: { total: 100 } }],
  ])("%s missing usage never becomes a full or empty allowance", async (provider, payload) => {
    proxyAwareFetch.mockImplementation(async () => response(payload));
    const result = await getUsageForProvider({ provider, accessToken: "synthetic-token", apiKey: "synthetic-key" });
    const rows = parseQuotaData(provider, result);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(quotaRemainingPercent(row)).toBeNull();
  });
  it("labels a Codex primary seven-day window by its actual duration and sends account identity", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ rate_limit: { primary_window: { used_percent: 29, limit_window_seconds: 604800, reset_at: 2000000000 } } }));
    const result = await getUsageForProvider({ provider: "codex", accessToken: "synthetic-token", providerSpecificData: { workspaceId: "workspace-b" } });
    expect(proxyAwareFetch.mock.calls[0][1].headers["ChatGPT-Account-ID"]).toBe("workspace-b");
    expect(parseQuotaData("codex", result)[0].name).toBe("Weekly (7d)");
    expect(quotaRemainingPercent(parseQuotaData("codex", result)[0])).toBe(71);
  });
  it("keeps a provider's percent-only MiniMax allowance instead of treating credits as percent", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 64 }] }));
    const result = await getUsageForProvider({ provider: "minimax", apiKey: "synthetic-key" });
    expect(quotaRemainingPercent(parseQuotaData("minimax", result)[0])).toBe(64);
  });
  it("does not use Vercel's advertised free plan as every account's allowance", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ balance: "95.50", total_used: "4.50" }));
    const result = await getUsageForProvider({ provider: "vercel-ai-gateway", apiKey: "synthetic-key" });
    const row = parseQuotaData("vercel-ai-gateway", result)[0];
    expect(row.balance).toBe(95.5);
    expect(row.total).toBeNull();
    expect(quotaRemainingPercent(row)).toBeNull();
  });
  it("treats GitHub's free-plan limited_user_quotas as remaining counts", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ monthly_quotas: { chat: 50 }, limited_user_quotas: { chat: 40 } }));
    const result = await getUsageForProvider({ provider: "github", accessToken: "synthetic-token" });
    expect(result.quotas.chat.used).toBe(10);
    expect(quotaRemainingPercent(parseQuotaData("github", result)[0])).toBe(80);
  });
  it("preserves GitHub's percent-only and current credit snapshot fields", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ quota_snapshots: {
      chat: { percent_remaining: 37 },
      premium_interactions: { entitlement: 300, credits_used: 25, quota_remaining: 275, percent_remaining: 91.67 },
    } }));
    const result = await getUsageForProvider({ provider: "github", accessToken: "synthetic-token" });
    expect(quotaRemainingPercent(parseQuotaData("github", result)[0])).toBe(37);
    expect(result.quotas.premium_interactions.used).toBe(25);
    expect(result.quotas.premium_interactions.remaining).toBe(275);
  });
});
