// Per-provider custom header overrides (upstream b3cf3fde): the API route
// validates names/values at the trust boundary, keys overrides by canonical
// registry id, and BaseExecutor merges user headers last at dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({ providerOverrides: {} })),
  updateSettings: vi.fn(async () => {}),
  proxyFetch: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyFetch,
}));

const route = await import("@/app/api/providers/[id]/overrides/route.js");

function put(id, body) {
  return route.PUT(
    new Request(`https://router.test/api/providers/${id}/overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function get(id) {
  return route.GET(new Request(`https://router.test/api/providers/${id}/overrides`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  mocks.getSettings.mockReset().mockResolvedValue({ providerOverrides: {} });
  mocks.updateSettings.mockClear();
});

describe("GET /api/providers/[id]/overrides", () => {
  it("returns stored headers plus the registry built-ins for the canonical id", async () => {
    mocks.getSettings.mockResolvedValue({
      providerOverrides: { cline: { headers: { "X-Custom": "yes" } } },
    });
    const response = await get("cl"); // alias form
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.headers).toEqual({ "X-Custom": "yes" });
    expect(typeof body.builtinHeaders).toBe("object");
  });

  it("returns empty objects for a provider with no override", async () => {
    const body = await (await get("openai")).json();
    expect(body.headers).toEqual({});
    expect(body.builtinHeaders).toEqual({});
  });
});

describe("PUT /api/providers/[id]/overrides", () => {
  it("stores clean headers keyed by canonical provider id", async () => {
    const response = await put("cl", { headers: { "X-Title": "Mine", "Empty-Header": "" } });
    expect(response.status).toBe(200);
    const [settings] = mocks.updateSettings.mock.calls[0];
    expect(settings.providerOverrides).toEqual({
      cline: { headers: { "X-Title": "Mine" } },
    });
  });

  it("rejects blocked request-structure and auth headers", async () => {
    for (const name of ["Host", "Authorization", "Cookie", "Content-Length", "Content-Type", "Connection", "Transfer-Encoding"]) {
      const response = await put("openai", { headers: { [name]: "x" } });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/cannot be overridden/);
    }
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects invalid names, values and sizes", async () => {
    expect((await put("openai", { headers: { "Bad Name": "x" } })).status).toBe(400);
    expect((await put("openai", { headers: { "X-Inject": "a\r\nHost: evil" } })).status).toBe(400);
    expect((await put("openai", { headers: { "X-Num": 5 } })).status).toBe(400);
    expect((await put("openai", { headers: { "X-Long": "v".repeat(8193) } })).status).toBe(400);
    expect((await put("openai", { headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"])) })).status).toBe(400);
    expect((await put("openai", { headers: "nope" })).status).toBe(400);
  });

  it("clears the override on an empty payload without touching other providers", async () => {
    mocks.getSettings.mockResolvedValue({
      providerOverrides: {
        cline: { headers: { "X-Old": "1" } },
        openai: { headers: { "X-Keep": "1" } },
      },
    });
    const response = await put("cl", { headers: {} });
    expect(response.status).toBe(200);
    const [settings] = mocks.updateSettings.mock.calls[0];
    expect(settings.providerOverrides).toEqual({ openai: { headers: { "X-Keep": "1" } } });
  });
});

describe("BaseExecutor merges providerOverrides last", () => {
  it("passes custom headers through the specialized Copilot Responses route", async () => {
    const { GithubExecutor } = await import("../../open-sse/executors/github.js");
    mocks.proxyFetch.mockResolvedValue(new Response("unavailable", { status: 500 }));
    const executor = new GithubExecutor();
    await executor.executeWithResponsesEndpoint({ model: "gpt-5", body: { messages: [{ role: "user", content: "hello" }] },
      stream: false, credentials: { apiKey: "key" },
      providerOverrides: { headers: { "X-Title": "user" } } });
    expect(mocks.proxyFetch.mock.calls.at(-1)[1].headers["X-Title"]).toBe("user");
  });

  it("assigns user headers over registry headers at dispatch", async () => {
    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    mocks.proxyFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "no",
    });

    class ProbeExecutor extends BaseExecutor {
      constructor() {
        super("probe", { id: "probe", format: "openai", retry: {} });
      }
      getFallbackCount() { return 1; }
      buildUrl() { return "https://probe.test/v1/chat/completions"; }
      buildHeaders() { return { "X-Title": "registry", Authorization: "Bearer sk" }; }
      transformRequest(_model, body) { return body; }
    }

    const executor = new ProbeExecutor();
    await executor.execute({
      model: "probe/model", body: { messages: [] }, stream: false,
      credentials: { apiKey: "sk" }, log: null,
      providerOverrides: { headers: { "X-Title": "user" } },
    });

    expect(mocks.proxyFetch).toHaveBeenCalled();
    const [, options] = mocks.proxyFetch.mock.calls.at(-1);
    expect(options.headers["X-Title"]).toBe("user");
    expect(options.headers.Authorization).toBe("Bearer sk");
  });
});
