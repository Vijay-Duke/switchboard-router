import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getComboModels: vi.fn(),
  getCombos: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  runWithLease: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: mocks.getSettings,
  getCombos: mocks.getCombos,
  getUsageStats: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.getComboModels,
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer /, "") || null,
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: mocks.authorize,
  runWithClientKeyLease: mocks.runWithLease,
}));
vi.mock("open-sse/translator/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  initTranslators: vi.fn(),
}));

const ROOT = path.resolve(import.meta.dirname, "../..");
const files = {
  chat: "src/sse/handlers/chat.js",
  embeddings: "src/sse/handlers/embeddings.js",
  fetch: "src/sse/handlers/fetch.js",
  image: "src/sse/handlers/imageGeneration.js",
  search: "src/sse/handlers/search.js",
  stt: "src/sse/handlers/stt.js",
  tts: "src/sse/handlers/tts.js",
  gemini: "src/app/api/v1beta/models/[...path]/route.js",
};

const source = Object.fromEntries(Object.entries(files).map(([name, file]) => [
  name,
  fs.readFileSync(path.join(ROOT, file), "utf8"),
]));

describe("client key provider-work boundaries", () => {

  it("returns policy rejection unchanged before model routing, credentials, or fetch on every surface", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.getCombos.mockResolvedValue([]);
    mocks.getComboModels.mockResolvedValue(null);
    mocks.authorize.mockImplementation(async () => ({
      ok: false,
      response: new Response("policy blocked", { status: 403, headers: { "x-policy": "blocked" } }),
    }));

    const modules = await Promise.all(Object.values(files).map((file) =>
      import(pathToFileURL(path.join(ROOT, file)).href)
    ));
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const byName = Object.fromEntries(Object.keys(files).map((name, index) => [name, modules[index]]));
    const jsonRequest = (body) => new Request("https://router.test/v1/test", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer gateway-key" },
      body: JSON.stringify(body),
    });
    const form = new FormData();
    form.set("model", "openai/whisper");

    const responses = await Promise.all([
      byName.chat.handleChat(jsonRequest({ model: "openai/gpt-5", messages: [] })),
      byName.embeddings.handleEmbeddings(jsonRequest({ model: "openai/embed", input: "x" })),
      byName.fetch.handleFetch(jsonRequest({ model: "openai", url: "https://example.com" })),
      byName.image.handleImageGeneration(jsonRequest({ model: "openai/image", prompt: "x" })),
      byName.search.handleSearch(jsonRequest({ model: "openai", query: "x" })),
      byName.stt.handleStt(new Request("https://router.test/v1/audio/transcriptions", {
        method: "POST", headers: { authorization: "Bearer gateway-key" }, body: form,
      })),
      byName.tts.handleTts(jsonRequest({ model: "openai/tts", input: "x" })),
      byName.gemini.POST(
        jsonRequest({
          contents: [{ parts: [{ text: "speak" }] }],
          generationConfig: { responseModalities: ["AUDIO"] },
        }),
        { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) },
      ),
    ]);

    expect(responses).toHaveLength(8);
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.headers.get("x-policy")).toBe("blocked");
      expect(await response.text()).toBe("policy blocked");
    }
    expect(mocks.authorize).toHaveBeenCalledTimes(8);
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.runWithLease).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);

  for (const [name, text] of Object.entries(source)) {
    it(`${name} uses one policy authorization and lease boundary`, () => {
      expect(text).toContain("authorizeClientKeyRequest({");
      expect(text).toContain("runWithClientKeyLease(");
      expect(text).not.toContain("gateRequireApiKey");
      expect(text).not.toContain("isValidApiKey");
      expect((text.match(/authorizeClientKeyRequest\(\{/g) || [])).toHaveLength(1);
    });
  }

  it("classifies model-only and combo-capable targets at the boundary", () => {
    for (const name of ["embeddings", "stt", "gemini"]) {
      expect(source[name]).toMatch(/target:\s*\{\s*kind:\s*["']model["']/);
    }
    for (const name of ["chat", "fetch", "image", "search", "tts"]) {
      expect(source[name]).toMatch(/kind:\s*comboModels\s*\?\s*["']combo["']\s*:\s*["']model["']/);
    }
  });

  it("never logs, stores, or forwards the raw gateway key after authorization", () => {
    for (const text of Object.values(source)) {
      expect(text).not.toContain("log.maskKey(rawKey)");
      expect(text).not.toMatch(/API Key:\s*\$\{/);
    }
    expect(source.chat).toContain('hashKey(clientKeyId || "local-no-key")');
    expect(source.chat).toContain("clientKeyId,");
    expect(source.chat).not.toMatch(/handleChatCore\([\s\S]*?\bapiKey\b/);
  });
});
