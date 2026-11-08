// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EndpointPageClient from "@/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js";
import KeyPolicyModal from "@/app/(dashboard)/dashboard/endpoint/components/KeyPolicyModal.js";
import { createHarness, h, click, jsonResponse, settle } from "./dashboard-dom-harness.js";

const harness = createHarness();
const clients = [];
const key = { id: "key-1", name: "Production", keyPrefix: "sk_test…", isActive: true,
  createdAt: "2026-11-01T00:00:00Z", tokenLimit: 100, usedTokens: 25 };
const initialData = { machineId: "test-machine", keys: [key], settings: { requireApiKey: true } };
function endpoint() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  return h(QueryClientProvider, { client }, h(EndpointPageClient, { initialData }));
}
afterEach(() => {
  harness.unmount();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

describe("endpoint key policy rendering", () => {
  it.each([null, undefined])("renders a closed policy modal with key %s", (apiKey) => {
    expect(renderToString(h(KeyPolicyModal, { apiKey, isOpen: false, onClose: vi.fn(), onSave: vi.fn() }))).toBe("");
  });

  it("server-renders the complete endpoint page before any key is selected", () => {
    const html = renderToString(endpoint());
    expect(html).toContain("API Endpoint");
    expect(html).toContain("Production");
    expect(html).toContain("25 / 100 tokens");
    expect(html).not.toContain('role="dialog"');
  });

  it("opens and closes a real key policy without crashing the page", async () => {
    vi.stubGlobal("fetch", vi.fn((url) => Promise.resolve(jsonResponse(
      String(url).startsWith("/api/keys") ? { keys: [key] } : initialData.settings
    ))));
    const container = await harness.mount(endpoint());
    expect(container.textContent).toContain("API Endpoint");
    await click(container.querySelector('[aria-label="Edit API key Production policy"]'));
    await settle(() => container.querySelector('[role="dialog"]'), "policy dialog");
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain("25 / 100 tokens (25%)");
    await click(dialog.querySelector('[aria-label="Close"]'));
    await settle(() => !container.querySelector('[role="dialog"]'), "closed policy dialog");
    expect(container.textContent).toContain("Production");
  });
});
