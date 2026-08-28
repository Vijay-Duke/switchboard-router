// @ts-check
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock DNS for safe catalog URLs so tests run offline
vi.mock("node:dns/promises", () => ({
  default: {
    lookup: async () => [{ address: "140.82.112.3", family: 4 }],
  },
}));

import {
  parseSkillInput,
  findSkillsInGitHubRepo,
  resolveSkillInput,
  MCP_PRESETS,
} from "@/lib/agent-library/catalog.js";
import {
  GET as catalogGet,
  POST as catalogPost,
} from "@/app/api/agent-library/catalog/route.js";

const MD_EGO = `---
name: ego-browser
description: AI browser automation skill
---

# Ego Browser
`;

const MD_FRONTEND = `---
name: frontend-design
description: Production UI aesthetics
---

# Frontend Design
`;

/**
 * @param {{ status?: number, body?: string|object, headers?: Record<string, string> }} r
 */
function mockResponse(r) {
  const headers = new Headers();
  if (r.headers) {
    for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
  }
  const status = r.status ?? 200;
  const isJson = typeof r.body === "object";
  const bodyText = isJson ? JSON.stringify(r.body) : (r.body ?? "");
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => bodyText,
    json: async () => (isJson ? r.body : JSON.parse(bodyText || "{}")),
  };
}

describe("parseSkillInput", () => {
  it("parses CLI command `npx skills add citrolabs/ego-lite`", () => {
    const res = parseSkillInput("npx skills add citrolabs/ego-lite");
    expect(res).toEqual({
      type: "github_repo",
      owner: "citrolabs",
      repo: "ego-lite",
      branch: "main",
      subpath: undefined,
    });
  });

  it("parses `skills add citrolabs/ego-lite -g --yes` with flags", () => {
    const res = parseSkillInput("skills add citrolabs/ego-lite -g --yes");
    expect(res).toEqual({
      type: "github_repo",
      owner: "citrolabs",
      repo: "ego-lite",
      branch: "main",
      subpath: undefined,
    });
  });

  it("parses repository shorthand `citrolabs/ego-lite`", () => {
    const res = parseSkillInput("citrolabs/ego-lite");
    expect(res).toEqual({
      type: "github_repo",
      owner: "citrolabs",
      repo: "ego-lite",
      branch: "main",
      subpath: undefined,
    });
  });

  it("parses repo with branch `citrolabs/ego-lite@v2.0`", () => {
    const res = parseSkillInput("citrolabs/ego-lite@v2.0");
    expect(res).toEqual({
      type: "github_repo",
      owner: "citrolabs",
      repo: "ego-lite",
      branch: "v2.0",
      subpath: undefined,
    });
  });

  it("parses GitHub web repo URL `https://github.com/citrolabs/ego-lite`", () => {
    const res = parseSkillInput("https://github.com/citrolabs/ego-lite");
    expect(res).toEqual({
      type: "github_repo",
      owner: "citrolabs",
      repo: "ego-lite",
      branch: "main",
    });
  });

  it("parses GitHub tree URL `https://github.com/citrolabs/ego-lite/tree/main/skills/ego-browser`", () => {
    const res = parseSkillInput("https://github.com/citrolabs/ego-lite/tree/main/skills/ego-browser");
    expect(res).toEqual({
      type: "github_repo",
      owner: "citrolabs",
      repo: "ego-lite",
      branch: "main",
      subpath: "skills/ego-browser",
    });
  });

  it("parses GitHub blob URL `https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md`", () => {
    const res = parseSkillInput("https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md");
    expect(res).toEqual({
      type: "direct_url",
      url: "https://raw.githubusercontent.com/citrolabs/ego-lite/main/skills/ego-browser/SKILL.md",
      suggestedId: "ego-browser",
    });
  });

  it("parses raw URL `https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md`", () => {
    const res = parseSkillInput("https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md");
    expect(res).toEqual({
      type: "direct_url",
      url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md",
      suggestedId: "frontend-design",
    });
  });

  it("rejects empty or whitespace-only inputs", () => {
    expect(parseSkillInput("")).toEqual({ type: "invalid", error: "Empty input" });
    expect(parseSkillInput("   ")).toEqual({ type: "invalid", error: "Empty input" });
  });
});

describe("findSkillsInGitHubRepo & resolveSkillInput", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers single skill via GitHub tree API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("api.github.com/repos/citrolabs/ego-lite/git/trees/main")) {
          return mockResponse({
            body: {
              tree: [
                { path: "README.md", type: "blob" },
                { path: "skills/ego-browser/SKILL.md", type: "blob" },
              ],
            },
          });
        }
        if (u.includes("raw.githubusercontent.com/citrolabs/ego-lite/main/skills/ego-browser/SKILL.md")) {
          return mockResponse({ body: MD_EGO });
        }
        return mockResponse({ status: 404 });
      })
    );

    const res = await resolveSkillInput("npx skills add citrolabs/ego-lite");
    expect(res.ok).toBe(true);
    expect(res.type).toBe("single");
    expect(res.skills).toHaveLength(1);
    expect(res.skills?.[0]).toMatchObject({
      skillId: "ego-browser",
      title: "ego-browser",
      description: "AI browser automation skill",
      rawUrl: "https://raw.githubusercontent.com/citrolabs/ego-lite/main/skills/ego-browser/SKILL.md",
    });
    expect(res.skills?.[0].preview).toContain("# Ego Browser");
  });

  it("discovers multiple skills in a monorepo (e.g. anthropics/skills)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("api.github.com/repos/anthropics/skills/git/trees/main")) {
          return mockResponse({
            body: {
              tree: [
                { path: "skills/frontend-design/SKILL.md", type: "blob" },
                { path: "skills/webapp-testing/SKILL.md", type: "blob" },
              ],
            },
          });
        }
        return mockResponse({ status: 404 });
      })
    );

    const res = await findSkillsInGitHubRepo("anthropics", "skills", "main");
    expect(res.ok).toBe(true);
    expect(res.type).toBe("multiple");
    expect(res.skills).toHaveLength(2);
    expect(res.skills?.map((s) => s.skillId)).toEqual(["frontend-design", "webapp-testing"]);
  });

  it("falls back to probing candidate paths if GitHub API is rate-limited (403)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("api.github.com")) {
          return mockResponse({ status: 403, body: { message: "API rate limit exceeded" } });
        }
        if (u.includes("skills/ego-browser/SKILL.md")) {
          return mockResponse({ body: MD_EGO });
        }
        return mockResponse({ status: 404 });
      })
    );

    const res = await resolveSkillInput("citrolabs/ego-lite");
    expect(res.ok).toBe(true);
    expect(res.skills?.[0].skillId).toBe("ego-browser");
    expect(res.skills?.[0].rawUrl).toContain("skills/ego-browser/SKILL.md");
  });

  it("resolves direct raw URLs directly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("raw.githubusercontent.com")) {
          return mockResponse({ body: MD_FRONTEND });
        }
        return mockResponse({ status: 404 });
      })
    );

    const res = await resolveSkillInput("https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md");
    expect(res.ok).toBe(true);
    expect(res.type).toBe("single");
    expect(res.skills?.[0].skillId).toBe("frontend-design");
    expect(res.skills?.[0].description).toBe("Production UI aesthetics");
  });
});

describe("catalog API route action: resolve", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles POST { action: 'resolve', input: 'npx skills add citrolabs/ego-lite' }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("api.github.com")) {
          return mockResponse({
            body: {
              tree: [{ path: "skills/ego-browser/SKILL.md", type: "blob" }],
            },
          });
        }
        if (u.includes("skills/ego-browser/SKILL.md")) {
          return mockResponse({ body: MD_EGO });
        }
        return mockResponse({ status: 404 });
      })
    );

    const req = new Request("http://127.0.0.1/api/agent-library/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "resolve",
        input: "npx skills add citrolabs/ego-lite",
      }),
    });

    const res = await catalogPost(req);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.skills[0].skillId).toBe("ego-browser");
  });

  it("returns 400 when input is missing", async () => {
    const req = new Request("http://127.0.0.1/api/agent-library/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolve", input: "" }),
    });

    const res = await catalogPost(req);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toBe("input_required");
  });
});

describe("MCP_PRESETS and GET /api/agent-library/catalog", () => {
  it("includes Executor.sh tool gateway as featured preset", () => {
    const executor = MCP_PRESETS.find((p) => p.id === "executor");
    expect(executor).toBeDefined();
    expect(executor).toMatchObject({
      id: "executor",
      name: "Executor.sh (Tool Gateway)",
      transport: "stdio",
      command: "npx",
      args: ["-y", "executor", "mcp"],
      featured: true,
    });
  });

  it("GET /api/agent-library/catalog returns both skill presets and MCP presets", async () => {
    const res = await catalogGet();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(Array.isArray(j.presets)).toBe(true);
    expect(Array.isArray(j.mcpPresets)).toBe(true);
    expect(j.mcpPresets.some((p) => p.id === "executor")).toBe(true);
  });
});
