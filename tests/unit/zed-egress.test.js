// Zed egress compliance: every proxyAwareFetch hop carries explicit
// provider/identity/format + redirect:"error", threads proxyOptions on all
// inference/auth/catalog hops, preserves client abort signals, and merges
// validated providerOverrides.headers into inference headers.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
// proxyAwareFetch captures globalThis.fetch at module load — mock BOTH
// specifiers so relative and aliased imports intercept the same fn.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

import {
  fetchZedAuthenticatedUser,
  fetchZedLlmToken,
  zedLlmFetch,
  clearZedCaches,
  ZED_HEADERS,
} from "open-sse/shared/zedAuth.js";
import ZedExecutor from "open-sse/executors/zed.js";

const CREDS = {
  accessToken: "user-access-token",
  providerSpecificData: { userId: "u1", systemId: "sys-1", organizationId: "org-1" },
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    text: async () => JSON.stringify(body),
  };
}

/** URL-routed transport: every zedAuth hop flows through the mocked fetch. */
function routeFetch({ completions = null } = {}) {
  let completionsCalls = 0;
  proxyAwareFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes("/client/users/me")) {
      return jsonResponse({ default_organization_id: "org-1" });
    }
    if (u.includes("/client/llm_tokens")) {
      return jsonResponse({ token: "llm-tok" });
    }
    if (u.includes("/completions")) {
      completionsCalls += 1;
      if (typeof completions === "function") return completions(completionsCalls);
      return jsonResponse({ done: true });
    }
    return jsonResponse({});
  });
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
  clearZedCaches();
});

describe("auth hops carry egress metadata", () => {
  it("fetchZedAuthenticatedUser: provider/identity/format + redirect:error + proxyOptions", async () => {
    routeFetch();
    const proxyOptions = { source: "pool", proxyPoolId: "pp1" };
    await fetchZedAuthenticatedUser(CREDS, { proxyOptions });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options, proxy] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toContain("cloud.zed.dev/client/users/me");
    expect(options.provider).toBe("zed");
    expect(options.identity).toBe("openai-node");
    expect(options.format).toBe("openai");
    expect(options.redirect).toBe("error");
    expect(proxy).toBe(proxyOptions);
  });

  it("fetchZedLlmToken: same egress contract on the token exchange", async () => {
    routeFetch();
    const signal = new AbortController().signal;
    const proxyOptions = { source: "pool", proxyPoolId: "pp2" };
    const token = await fetchZedLlmToken(CREDS, { signal, proxyOptions });

    expect(token).toBe("llm-tok");
    const [url, options, proxy] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toContain("cloud.zed.dev/client/llm_tokens");
    expect(options.provider).toBe("zed");
    expect(options.identity).toBe("openai-node");
    expect(options.format).toBe("openai");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBe(signal); // client abort preserved
    expect(proxy).toBe(proxyOptions);
  });
});

describe("inference hop carries egress metadata + proxy", () => {
  it("zedLlmFetch threads proxyOptions, signal, and never follows redirects", async () => {
    routeFetch();
    const signal = new AbortController().signal;
    const proxyOptions = { source: "legacy", connectionProxyUrl: "http://127.0.0.1:9" };

    const response = await zedLlmFetch(CREDS, "/completions", {
      signal,
      proxyOptions,
      fetchOptions: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    });
    expect(response.ok).toBe(true);

    // Token exchange hop + completions hop both carry the contract.
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    for (const [url, options, proxy] of proxyAwareFetch.mock.calls) {
      expect(options.provider).toBe("zed");
      expect(options.identity).toBe("openai-node");
      expect(options.format).toBe("openai");
      expect(options.redirect).toBe("error");
      expect(proxy).toBe(proxyOptions);
    }
    const [compUrl, compOptions] = proxyAwareFetch.mock.calls[1];
    expect(String(compUrl)).toContain("cloud.zed.dev/completions");
    expect(compOptions.signal).toBe(signal);
    expect(compOptions.headers.Authorization).toBe("Bearer llm-tok");
  });

  it("401 responses trigger exactly one authorized retry with a fresh token", async () => {
    routeFetch({
      completions: (n) => (n === 1 ? jsonResponse({ error: "expired" }, 401) : jsonResponse({ ok: true })),
    });
    const response = await zedLlmFetch(CREDS, "/completions", { fetchOptions: { method: "POST" } });
    expect(response.ok).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);

    const [u1] = proxyAwareFetch.mock.calls[1];
    const [u3] = proxyAwareFetch.mock.calls[3];
    expect(u3).toEqual(u1); // same URL retried after the token refresh
  });
});

describe("executor passes proxy + merges validated overrides end to end", () => {
  async function executorExecute(extra = {}) {
    const executor = new ZedExecutor();
    executor.config = {};
    return executor.execute({
      model: "claude-opus-x",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: CREDS,
      ...extra,
    });
  }

  function completionsCall() {
    const call = proxyAwareFetch.mock.calls.find(([u]) => String(u).includes("/completions"));
    expect(call).toBeTruthy();
    return call;
  }

  it("threads proxyOptions + signal and stamps egress metadata on the wire", async () => {
    routeFetch();
    const signal = new AbortController().signal;
    const proxyOptions = { source: "pool", proxyPoolId: "pp3" };
    await executorExecute({ signal, proxyOptions });

    const [url, options, proxy] = completionsCall();
    expect(String(url)).toContain("cloud.zed.dev/completions");
    expect(options.provider).toBe("zed");
    expect(options.identity).toBe("openai-node");
    expect(options.format).toBe("openai");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBe(signal); // abort preserved through the executor
    expect(proxy).toBe(proxyOptions); // inference hop rides the connection proxy
    expect(options.headers.Authorization).toBe("Bearer llm-tok");
    expect(options.headers["x-zed-version"]).toBeTruthy();
  });

  it("request-level providerOverrides.headers ride on top of the executor headers", async () => {
    routeFetch();
    await executorExecute({
      credentials: {
        ...CREDS,
        providerOverrides: { headers: { "x-both": "cred", "x-cred": "cred" } },
      },
      providerOverrides: { headers: { "x-both": "req", "x-req": "req" } },
    });

    const headers = completionsCall()[1].headers;
    expect(headers["x-both"]).toBe("req"); // request-level wins
    expect(headers["x-cred"]).toBe("cred"); // credential-level still applies
    expect(headers["x-req"]).toBe("req");
    expect(headers["User-Agent"]).toBe("switchboard/zed");
  });

  it("credential-level overrides apply when no request-level overrides are given", async () => {
    routeFetch();
    await executorExecute({
      credentials: {
        ...CREDS,
        providerOverrides: { headers: { "x-conn-override": "yes" } },
      },
    });
    expect(completionsCall()[1].headers["x-conn-override"]).toBe("yes");
  });

  it("no overrides → stock executor headers untouched", async () => {
    routeFetch();
    await executorExecute();
    const headers = completionsCall()[1].headers;
    expect(headers["x-conn-override"]).toBeUndefined();
    expect(headers[ZED_HEADERS.clientSupportsStatus]).toBe("true");
  });
});
