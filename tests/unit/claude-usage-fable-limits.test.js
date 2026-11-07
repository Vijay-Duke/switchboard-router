// Upstream e214fb1c + 4ad1e7a4: model-scoped weekly limits (e.g. Fable) come in
// limits[] (kind "weekly_scoped"), not as seven_day_* keys. Parse them; never
// fabricate a row when the account has no such window.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
const { parseQuotaData } = await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js");

function respond(body) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

let n = 0;
const token = () => `tok-${Date.now()}-${n++}`;

describe("Claude usage: weekly_scoped limits", () => {
  beforeEach(() => fetchMock.mockReset());

  it("parses a Fable weekly_scoped limit into a weekly fable row", async () => {
    respond({
      five_hour: { utilization: 10, resets_at: "2026-11-08T00:00:00Z" },
      seven_day: { utilization: 20, resets_at: "2026-11-12T00:00:00Z" },
      limits: [{ kind: "weekly_scoped", percent: 35, resets_at: "2026-11-12T00:00:00Z", scope: { model: { display_name: "Fable" } } }],
    });
    const res = await getClaudeUsage(token(), null, { force: true });
    expect(res.quotas["weekly fable (7d)"]).toMatchObject({ used: 35, remaining: 65, total: 100 });
  });

  it("does not fabricate a Fable row when limits[] has none", async () => {
    respond({ seven_day: { utilization: 20, resets_at: "2026-11-12T00:00:00Z" } });
    const res = await getClaudeUsage(token(), null, { force: true });
    expect(res.quotas["weekly fable (7d)"]).toBeUndefined();
    expect(res.quotas["weekly (7d)"]).toBeDefined();
  });

  it("orders Claude rows session → weekly → fable → opus → sonnet", () => {
    const rows = parseQuotaData("claude", {
      quotas: {
        "weekly sonnet (7d)": { used: 1, total: 100 },
        "weekly fable (7d)": { used: 1, total: 100 },
        "weekly (7d)": { used: 1, total: 100 },
        "session (5h)": { used: 1, total: 100 },
        "weekly opus (7d)": { used: 1, total: 100 },
      },
    });
    expect(rows.map((r) => r.name)).toEqual([
      "session (5h)", "weekly (7d)", "weekly fable (7d)", "weekly opus (7d)", "weekly sonnet (7d)",
    ]);
  });
});
