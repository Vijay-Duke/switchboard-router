// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
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

  it("hydrates saved key dates across different server and browser locales/timezones", async () => {
    const nativeFormat = Date.prototype.toLocaleDateString;
    let locale = "en-AU", timeZone = "Australia/Sydney";
    const dateFormat = vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (locales, options) {
      return nativeFormat.call(this, locales || locale, { timeZone, ...options });
    });
    const container = document.createElement("div");
    const recoverableErrors = [];
    let root;
    try {
      container.innerHTML = renderToString(endpoint());
      document.body.appendChild(container);
      locale = "en-US";
      timeZone = "America/Los_Angeles";
      vi.stubGlobal("fetch", vi.fn(async (url) => jsonResponse(
        String(url).startsWith("/api/keys") ? { keys: [key] } : initialData.settings
      )));
      await act(async () => {
        root = hydrateRoot(container, endpoint(), {
          onRecoverableError: (error) => recoverableErrors.push(error.message),
        });
      });
      expect(recoverableErrors).toEqual([]);
      expect(container.textContent).toContain("Production");
      expect(container.textContent).toContain("Created 10/31/2026");
    } finally {
      if (root) act(() => root.unmount());
      container.remove();
      dateFormat.mockRestore();
    }
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
