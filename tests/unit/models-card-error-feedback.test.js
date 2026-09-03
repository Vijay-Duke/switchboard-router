// @vitest-environment happy-dom
// U4 regression: ModelsCard mutations must surface 4xx/5xx server errors as
// toasts instead of silently doing nothing (fetchJson throws on non-ok and the
// catch reports via reportClientError into the notification store).
// JSX is avoided (React.createElement) because the vitest transform only
// parses JSX inside src/**.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ModelsCard from "@/app/(dashboard)/dashboard/providers/components/ModelsCard";
import { fetchJson } from "@/shared/query/fetchJson";
import { reportClientError } from "@/shared/utils/clientFeedback";
import { getProviderAlias } from "@/shared/constants/providers";
import { useNotificationStore } from "@/store/notificationStore";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROVIDER_ID = "openai";
const PROVIDER_ALIAS = getProviderAlias(PROVIDER_ID);

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

let root = null;
let container = null;
let realFetch = null;

function mount(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root.render(element);
    // Flush mount-time fetchData (3 fetches + json + state updates).
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

function notifications() {
  return useNotificationStore.getState().notifications;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  useNotificationStore.getState().clearAll();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) {
    await act(async () => {
      root.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  useNotificationStore.getState().clearAll();
  vi.restoreAllMocks();
});

describe("ModelsCard mutation error feedback (U4)", () => {
  it("surfaces the server error as a toast when deleting a custom model fails", async () => {
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const method = (init.method || "GET").toUpperCase();
      if (String(url).startsWith("/api/models/custom") && method === "DELETE") {
        return jsonResponse({ error: "alias in use" }, { ok: false, status: 409 });
      }
      if (String(url).startsWith("/api/models/alias")) {
        return jsonResponse({ aliases: {} });
      }
      if (String(url).startsWith("/api/providers")) {
        return jsonResponse({ connections: [] });
      }
      if (String(url).startsWith("/api/models/custom")) {
        return jsonResponse({
          models: [{ id: "my-custom-model", providerAlias: PROVIDER_ALIAS, type: "llm", name: "My Custom" }],
        });
      }
      return jsonResponse({});
    });

    await mount(h(ModelsCard, { providerId: PROVIDER_ID }));

    const deleteButton = container.querySelector('button[title="Remove custom model"]');
    expect(deleteButton).not.toBeNull();
    await click(deleteButton);

    const messages = notifications().map((n) => n.message);
    expect(messages.some((m) => m.includes("alias in use"))).toBe(true);
    expect(notifications().some((n) => n.type === "error")).toBe(true);
  });

  it("delete-alias path throws the server error via fetchJson so the catch can toast it", async () => {
    // Mirrors handleDeleteAlias: DELETE /api/models/alias?alias=... must reject
    // on 409 with the server's `error` string (previously `if (res.ok)` dropped it).
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "alias in use" }, { ok: false, status: 409 }));

    let thrown = null;
    try {
      await fetchJson("/api/models/alias?alias=my-alias", { method: "DELETE" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).toBe("alias in use");

    reportClientError("delete alias error:", thrown);
    expect(notifications().some((n) => n.message.includes("alias in use"))).toBe(true);
  });
});
