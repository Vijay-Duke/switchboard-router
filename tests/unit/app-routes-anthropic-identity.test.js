// Regression guard: every outbound call bound for api.anthropic.com must go
// through proxyAwareFetch with the claude-cli identity profile — no bare
// fetch, no openai-node fallback. Covers dashboard routes that sidestep the
// open-sse executors: key validation, connection model listing, and the
// cowork MCP registry poll.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
  default: (...args) => fetchMock(...args),
}));

vi.mock("../../src/models", () => ({
  getProviderConnectionById: vi.fn(),
  getProviderNodeById: vi.fn(),
}));

vi.mock("../../src/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  refreshImportedCursorCredentials: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));

import { POST as validateProvider } from "../../src/app/api/providers/validate/route.js";
import { GET as getConnectionModels } from "../../src/app/api/providers/[id]/models/route.js";
import { GET as getMcpRegistry } from "../../src/app/api/cli-tools/cowork-mcp-registry/route.js";
import { getProviderConnectionById } from "../../src/models";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function anthropicCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("api.anthropic.com"));
}

describe("dashboard routes wear the claude-cli identity to api.anthropic.com", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "claude-sonnet-5" }] }));
  });

  it("provider key validation posts to /v1/messages as claude-cli", async () => {
    const request = new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test" }),
    });

    const res = await validateProvider(request);
    expect(res.status).toBe(200);

    const calls = anthropicCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0][1]).toMatchObject({ identity: "claude-cli", provider: "anthropic", format: "claude" });
    expect(calls[0][1].headers["x-api-key"]).toBe("sk-ant-test");
  });

  it("connection model listing for the anthropic apikey provider uses claude-cli", async () => {
    getProviderConnectionById.mockResolvedValue({
      id: "conn-anthropic",
      provider: "anthropic",
      apiKey: "sk-ant-test",
    });

    const res = await getConnectionModels(new Request("http://localhost/api/providers/conn-anthropic/models"), {
      params: Promise.resolve({ id: "conn-anthropic" }),
    });
    expect(res.status).toBe(200);

    const calls = anthropicCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0][1]).toMatchObject({ identity: "claude-cli", provider: "anthropic" });
  });

  it("anthropic-compatible node on the official base wears claude-cli, third-party stays openai-node", async () => {
    getProviderConnectionById.mockResolvedValue({
      id: "conn-compat",
      provider: "anthropic-compatible-official",
      apiKey: "sk-ant-test",
      providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" },
    });

    await getConnectionModels(new Request("http://localhost/api/providers/conn-compat/models"), {
      params: Promise.resolve({ id: "conn-compat" }),
    });
    let calls = anthropicCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ identity: "claude-cli", provider: "anthropic-compatible-official" });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    getProviderConnectionById.mockResolvedValue({
      id: "conn-compat",
      provider: "anthropic-compatible-relay",
      apiKey: "sk-ant-test",
      providerSpecificData: { baseUrl: "https://relay.example.com/v1" },
    });

    await getConnectionModels(new Request("http://localhost/api/providers/conn-compat/models"), {
      params: Promise.resolve({ id: "conn-compat" }),
    });
    calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain("relay.example.com/v1/models");
    expect(calls[0][1]).toMatchObject({ identity: "openai-node" });
  });

  it("cowork MCP registry poll presents as claude-cli", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      servers: [{ server: { name: "s", remotes: [{ type: "http", url: "https://mcp.example.com/sse" }] }, _meta: {} }],
      metadata: {},
    }));

    const res = await getMcpRegistry(new Request("http://localhost/api/cli-tools/cowork-mcp-registry"));
    expect(res.status).toBe(200);

    const calls = anthropicCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain("https://api.anthropic.com/mcp-registry/v0/servers");
    expect(calls[0][1]).toMatchObject({ identity: "claude-cli", provider: "claude", format: "claude" });
  });
});
