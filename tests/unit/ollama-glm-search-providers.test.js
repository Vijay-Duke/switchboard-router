import { describe, expect, it, vi } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers.js";

describe("ollama-search provider registration", () => {
  it("registers ollama-search with a credential fallback onto the ollama chat provider", () => {
    const entry = REGISTRY.find((candidate) => candidate.id === "ollama-search");

    expect(entry).toMatchObject({
      category: "apikey",
      authType: "apikey",
      serviceKinds: ["webSearch"],
      credentialFallback: "ollama",
      searchConfig: {
        baseUrl: "https://ollama.com/api/web_search",
        method: "POST",
        authHeader: "bearer",
        defaultMaxResults: 5,
        maxMaxResults: 10,
      },
    });
    expect(AI_PROVIDERS["ollama-search"].credentialFallback).toBe("ollama");
    expect(getProvidersByKind("webSearch").map((p) => p.id)).toContain("ollama-search");
  });

  it("folds GLM coding web search onto the glm provider itself", () => {
    const entry = REGISTRY.find((candidate) => candidate.id === "glm");

    expect(entry.serviceKinds).toEqual(["llm", "webSearch"]);
    expect(entry.searchConfig).toMatchObject({
      baseUrl: "https://api.z.ai/api/mcp/web_search_prime/mcp",
      method: "POST",
      authHeader: "bearer",
      maxMaxResults: 50,
    });
    expect(REGISTRY.find((candidate) => candidate.id === "zai-search")).toBeUndefined();
    expect(AI_PROVIDERS.glm.serviceKinds).toContain("webSearch");
    expect(getProvidersByKind("webSearch").map((p) => p.id)).toContain("glm");
  });
});

describe("ollama-search request building", () => {
  it("posts the query with bearer auth", () => {
    const { url, init } = buildSearchRequest(
      { id: "ollama-search", baseUrl: "https://ollama.com/api/web_search" },
      { query: "what is a router", maxResults: 7, token: "ollama-key", country: "us" },
    );

    expect(url).toBe("https://ollama.com/api/web_search");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer ollama-key",
    });
    expect(JSON.parse(init.body)).toEqual({
      query: "what is a router",
      max_results: 7,
      country: "us",
    });
  });

  it("normalizes the ollama results array", () => {
    const normalized = normalizeSearchResponse("ollama-search", {
      results: [
        { title: "Docs", url: "https://example.com/docs", content: "Read the docs" },
        { title: "Blog", url: "https://example.com/blog", content: "A post", published_at: "2026-01-02" },
      ],
    }, "unused", "web");

    expect(normalized.totalResults).toBe(2);
    expect(normalized.results[0]).toMatchObject({
      title: "Docs",
      url: "https://example.com/docs",
      snippet: "Read the docs",
      content: { format: "text", text: "Read the docs" },
      citation: { provider: "ollama-search" },
    });
    expect(normalized.results[1].published_at).toBe("2026-01-02");
  });
});

describe("glm MCP search", () => {
  it("wraps the query in a JSON-RPC tools/call envelope without upstream branding", () => {
    const { url, init } = buildSearchRequest(
      { id: "glm", baseUrl: "https://api.z.ai/api/mcp/web_search_prime/mcp" },
      { query: "glm search", maxResults: 5, token: "glm-key" },
    );

    expect(url).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer glm-key");

    const body = JSON.parse(init.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(body.params).toEqual({
      name: "web_search_prime",
      arguments: { search_query: "glm search", count: 5 },
    });
    expect(body.id).toMatch(/^sb-/);
    expect(body.id).not.toContain("9r");
  });

  it("normalizes the MCP text envelope", () => {
    const inner = JSON.stringify({
      results: [
        { title: "Result", link: "https://example.com/a", content: "snippet text", publish_date: "2026-03-04", icon: "https://example.com/fav.png", media: "Example Media" },
      ],
    });
    const normalized = normalizeSearchResponse("glm", {
      result: { content: [{ type: "text", text: inner }] },
    }, "unused", "web");

    expect(normalized.totalResults).toBe(1);
    expect(normalized.results[0]).toMatchObject({
      title: "Result",
      url: "https://example.com/a",
      snippet: "snippet text",
      published_at: "2026-03-04",
      favicon_url: "https://example.com/fav.png",
      citation: { provider: "glm" },
    });
    expect(normalized.results[0].metadata.source_type).toBe("Example Media");
  });

  it("falls back to the news array and tolerates a broken envelope", () => {
    const newsOnly = normalizeSearchResponse("glm", {
      result: { content: [{ type: "text", text: JSON.stringify({ news: [{ title: "N", link: "https://example.com/n" }] }) }] },
    }, "unused", "web");
    expect(newsOnly.totalResults).toBe(1);
    expect(newsOnly.results[0].url).toBe("https://example.com/n");

    const broken = normalizeSearchResponse("glm", {
      result: { content: [{ type: "text", text: "not json" }] },
    }, "unused", "web");
    expect(broken).toEqual({ results: [], totalResults: 0 });
  });
});
