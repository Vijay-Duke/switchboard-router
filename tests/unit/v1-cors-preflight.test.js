/**
 * QA-023 — compatibility API OPTIONS preflight must reflect the requesting
 * Origin so browser clients can issue cross-origin gateway requests.
 */
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
  getProviderCredentials: vi.fn(),
  clearAccountError: vi.fn(),
  markAccountUnavailable: vi.fn(),
  authorizeClientKeyRequest: vi.fn(),
  runWithClientKeyLease: vi.fn(),
  withConnectionInFlight: vi.fn(),
  buildModelsList: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
vi.mock("@/lib/db/index.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  clearAccountError: mocks.clearAccountError,
  markAccountUnavailable: mocks.markAccountUnavailable,
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: mocks.authorizeClientKeyRequest,
  runWithClientKeyLease: mocks.runWithClientKeyLease,
}));
vi.mock("@/sse/services/connectionInFlight.js", () => ({
  withConnectionInFlight: mocks.withConnectionInFlight,
}));
vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));

const [{ OPTIONS: completionsOptions }, { OPTIONS: messagesOptions }] = await Promise.all([
  import("../../src/app/api/v1/chat/completions/route.js"),
  import("../../src/app/api/v1/messages/route.js"),
]);
const { OPTIONS: geminiPathOptions } = await import(
  "../../src/app/api/v1beta/models/[...path]/route.js"
);
const { OPTIONS: geminiListOptions } = await import("../../src/app/api/v1beta/models/route.js");
const { OPTIONS: ollamaOptions } = await import("../../src/app/api/v1/api/chat/route.js");
const { OPTIONS: modelsInfoOptions } = await import("../../src/app/api/v1/models/info/route.js");
const { OPTIONS: modelsKindOptions } = await import("../../src/app/api/v1/models/[kind]/route.js");

const GATEWAY = "http://127.0.0.1:22128";
const BROWSER_ORIGIN = "http://127.0.0.1:22129";

function preflight(url, handler, origin) {
  const headers = origin ? { Origin: origin } : {};
  return handler(new Request(url, { method: "OPTIONS", headers }));
}

const PREFLIGHT_ROUTES = [
  ["POST /v1/chat/completions", `${GATEWAY}/v1/chat/completions`, completionsOptions],
  ["POST /v1/messages", `${GATEWAY}/v1/messages`, messagesOptions],
  ["POST /v1beta/models/:model:generateContent", `${GATEWAY}/v1beta/models/qa-openai/qa-chat:generateContent`, geminiPathOptions],
  ["GET /v1beta/models", `${GATEWAY}/v1beta/models`, geminiListOptions],
  ["POST /v1/api/chat", `${GATEWAY}/v1/api/chat`, ollamaOptions],
  ["GET /v1/models/info", `${GATEWAY}/v1/models/info`, modelsInfoOptions],
  ["GET /v1/models/:kind", `${GATEWAY}/v1/models/llm`, modelsKindOptions],
];

describe("compatibility API CORS preflight (QA-023)", () => {
  for (const [label, url, handler] of PREFLIGHT_ROUTES) {
    it(`${label}: preflight reflects the requesting browser origin`, async () => {
      const res = await preflight(url, handler, BROWSER_ORIGIN);

      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
      expect(res.headers.get("access-control-allow-methods")).toMatch(/GET|POST/);
      expect(res.headers.get("access-control-allow-headers")).toBe("*");
      // Reflected origin must vary per request in shared caches.
      expect(res.headers.get("vary")).toBe("Origin");
    });

    it(`${label}: preflight without Origin falls back to *`, async () => {
      const res = await preflight(url, handler, null);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  }
});
