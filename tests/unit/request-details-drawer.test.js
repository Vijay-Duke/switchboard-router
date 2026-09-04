// @vitest-environment happy-dom
// O1: the request inspector drawer must fetch the unredacted row by id;
// O3: filter changes restart at page 1; O31: stale list responses are ignored.

import { afterEach, describe, expect, it, vi } from "vitest";
import RequestDetailsTab from "@/app/(dashboard)/dashboard/usage/components/RequestDetailsTab";
import { useNotificationStore } from "@/store/notificationStore";
import {
  createHarness,
  h,
  settle,
  click,
  setValue,
  jsonResponse,
  deferred,
  findByText,
} from "./dashboard-dom-harness.js";

const harness = createHarness();

function row(id, overrides = {}) {
  return {
    id,
    timestamp: "2026-08-05T00:00:00Z",
    provider: "openai",
    model: "gpt-x",
    status: "success",
    tokens: { prompt_tokens: 1, completion_tokens: 1 },
    latency: { total: 10 },
    request: { redacted: true },
    response: { redacted: true },
    ...overrides,
  };
}

const FULL = {
  request: { messages: [{ role: "user", content: "secret prompt" }] },
  providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
  providerResponse: { choices: [] },
  response: { content: "secret answer" },
};

function listResponse(details, pagination = {}) {
  return {
    details,
    pagination: { page: 1, pageSize: 20, totalItems: details.length, totalPages: 1, ...pagination },
  };
}

/** fetch stub routed by URL; `list`/`detail` can be functions of the URL. */
function stubFetch({ list, detail }) {
  const fetchMock = vi.fn((url) => {
    const u = String(url);
    if (u.startsWith("/api/usage/request-details/")) return Promise.resolve(detail(u));
    if (u.startsWith("/api/usage/request-details?")) return Promise.resolve(list(u));
    if (u === "/api/usage/providers") return Promise.resolve(jsonResponse({ providers: [{ id: "openai", name: "OpenAI" }, { id: "anthropic", name: "Anthropic" }] }));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function listCalls(fetchMock) {
  return fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/usage/request-details?"));
}

afterEach(() => {
  harness.unmount();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request details drawer (O1)", () => {
  it("fetches the unredacted row by id when the drawer opens", async () => {
    const fetchMock = stubFetch({
      list: () => jsonResponse(listResponse([row("abc")])),
      detail: () => jsonResponse({ detail: { ...row("abc"), ...FULL } }),
    });
    const container = await harness.mount(h(RequestDetailsTab));
    await settle(() => findByText(container, "button", "Detail"), "row rendered");

    await click(findByText(container, "button", "Detail"));
    await settle(() => container.textContent.includes("secret prompt"), "full payload rendered");

    expect(fetchMock).toHaveBeenCalledWith("/api/usage/request-details/abc");
    expect(container.textContent).toContain("secret answer");
    expect(container.textContent).not.toContain('"redacted": true');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("falls back to the redacted row with a notice when the detail fetch fails", async () => {
    stubFetch({
      list: () => jsonResponse(listResponse([row("abc")])),
      detail: () => jsonResponse({ error: "not found" }, 404),
    });
    const container = await harness.mount(h(RequestDetailsTab));
    await settle(() => findByText(container, "button", "Detail"), "row rendered");

    await click(findByText(container, "button", "Detail"));
    await settle(() => container.querySelector('[role="alert"]'), "fallback notice");

    expect(container.querySelector('[role="alert"]').textContent).toContain("Full payload unavailable");
    expect(container.textContent).toContain('"redacted": true');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("request details filters (O3)", () => {
  it("restarts at page 1 when a filter changes", async () => {
    const fetchMock = stubFetch({
      list: () => jsonResponse(listResponse([row("abc")], { totalItems: 100, totalPages: 5 })),
      detail: () => jsonResponse({}),
    });
    const container = await harness.mount(h(RequestDetailsTab));
    await settle(() => container.querySelector('[aria-label="Next page"]'), "pagination rendered");

    await click(container.querySelector('[aria-label="Next page"]'));
    await settle(() => listCalls(fetchMock).some((u) => u.includes("page=2")), "page 2 requested");

    await setValue(container.querySelector("#provider-filter"), "openai");
    await settle(() => listCalls(fetchMock).some((u) => u.includes("provider=openai")), "filtered request");

    const last = listCalls(fetchMock).at(-1);
    expect(last).toContain("provider=openai");
    expect(last).toContain("page=1");
  });
});

describe("request details stale responses (O31)", () => {
  it("ignores a slow earlier response that resolves after a newer one", async () => {
    const slow = deferred();
    const fetchMock = stubFetch({
      list: (u) => {
        if (u.includes("provider=openai")) return slow.promise;
        if (u.includes("provider=anthropic")) return jsonResponse(listResponse([row("2", { model: "model-newer" })]));
        return jsonResponse(listResponse([row("1", { model: "model-initial" })]));
      },
      detail: () => jsonResponse({}),
    });
    const container = await harness.mount(h(RequestDetailsTab));
    await settle(() => container.textContent.includes("model-initial"), "initial rows");

    const select = container.querySelector("#provider-filter");
    await setValue(select, "openai");
    await setValue(select, "anthropic");
    await settle(() => container.textContent.includes("model-newer"), "newer rows rendered");

    slow.resolve(jsonResponse(listResponse([row("3", { model: "model-stale" })])));
    await settle(() => listCalls(fetchMock).length >= 3, "all list fetches issued");

    expect(container.textContent).toContain("model-newer");
    expect(container.textContent).not.toContain("model-stale");
  });
});
