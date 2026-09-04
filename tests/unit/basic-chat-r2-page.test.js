// @vitest-environment happy-dom
// @ts-check
// Basic Chat render tests for round-2 findings:
// T10 provider load failure shows the real error (not the empty-state text),
// T11 send error banner clears on the next successful send,
// T12 switching sessions aborts the live stream,
// T13 streaming tokens do not re-persist sessions per token,
// T14 persisted sessions show their own modelName caption,
// T15 non-image attachments are rejected with a notice,
// T16 connection ids are URL-encoded in the models fetch.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHarness, setValue, jsonResponse, h } from "./dashboard-dom-harness.js";

vi.mock("@/shared/constants/providers", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isOpenAICompatibleProvider: () => false,
    isAnthropicCompatibleProvider: () => false,
  };
});
vi.mock("@/shared/constants/models", () => ({
  getModelsByProviderId: () => [],
}));
vi.mock("next/image", () => ({
  default: (props) => React.createElement("img", { alt: props.alt, src: props.src }),
}));

import BasicChatPageClient from "../../src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
// Poll until `pred()` is truthy (async fetch/stream work under a loaded runner).
const waitFor = async (pred, label) => {
  for (let i = 0; i < 400; i++) {
    const v = pred();
    if (v) return v;
    await tick(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
};

function chatFetch(over = {}) {
  return vi.fn(async (url, init) => {
    const u = String(url);
    if (u === "/api/providers") {
      return over.providers?.() ?? jsonResponse({ connections: [{ id: "c1", provider: "provx", name: "Prov X" }] });
    }
    if (u === "/api/combos") return over.combos?.() ?? jsonResponse({ combos: [] });
    if (/^\/api\/providers\/.+\/models$/.test(u)) {
      return over.models?.(u) ?? jsonResponse({ models: [{ id: "m1", name: "Model One" }] });
    }
    if (u === "/v1/chat/completions") {
      return over.chat?.(init) ?? jsonResponse({}, 500);
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

/** A never-closing SSE response whose chunks the test pushes. */
function openStream() {
  let ctrl;
  const stream = new ReadableStream({
    start(c) { ctrl = c; },
  });
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (text) => ctrl.enqueue(new TextEncoder().encode(text)),
    close: () => ctrl.close(),
  };
}

function finishedStream(text) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const session = (id, modelName, messages, updatedAt = "2026-01-01T00:00:00.000Z") => ({
  id,
  title: `Chat ${id}`,
  providerId: "provx",
  providerName: "Prov X",
  modelId: "unresolved-model",
  modelName,
  messages,
  updatedAt,
});

async function mountChat(over) {
  const fetchMock = over?.fetchMock ?? chatFetch(over?.handlers || {});
  globalThis.fetch = fetchMock;
  const harness = createHarness();
  await harness.mount(h(BasicChatPageClient));
  await tick(10);
  return { harness, fetchMock };
}

const send = async (harness, text) => {
  const area = harness.container.querySelector('textarea[placeholder="Message AI"]');
  await setValue(area, text);
  // Model discovery is async; wait until the composer is actually sendable.
  let btn = harness.container.querySelector('[aria-label="Send message"]');
  for (let i = 0; i < 100 && (!btn || btn.disabled); i++) {
    await tick(5);
    btn = harness.container.querySelector('[aria-label="Send message"]');
  }
  if (!btn || btn.disabled) throw new Error("send button never became enabled");
  btn.click();
  await tick(10);
};

describe("basic-chat page (round-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.localStorage.clear();
  });

  it("T16: encodes connection ids in the models fetch URL", async () => {
    const { fetchMock } = await mountChat({
      handlers: {
        providers: () => jsonResponse({ connections: [{ id: "a b/c", provider: "provx", name: "X" }] }),
      },
    });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain("/api/providers/a%20b%2Fc/models");
  });

  it("T10: provider load failure shows the backend error, not the empty-state text", async () => {
    const { harness } = await mountChat({
      handlers: { providers: () => jsonResponse({ error: "provider backend down" }, 500) },
    });
    await tick(10);
    expect(harness.container.textContent).toContain("provider backend down");
    expect(harness.container.textContent).not.toContain("No providers connected yet.");
    harness.unmount();
  });

  it("T14: persisted sessions show their own modelName caption", async () => {
    globalThis.localStorage.setItem("basic-chat.sessions", JSON.stringify([
      session("s1", "Model A", [{ id: "m1", role: "user", content: "hello a", createdAt: "2026-01-01T00:00:00.000Z" }]),
      session("s2", "Model B", [
        { id: "m2", role: "user", content: "hello b", createdAt: "2026-01-01T00:00:01.000Z" },
        { id: "m3", role: "assistant", content: "hi", createdAt: "2026-01-01T00:00:02.000Z" },
      ], "2026-01-01T00:00:02.000Z"),
    ]));
    globalThis.localStorage.setItem("basic-chat.activeSessionId", "s2");

    const { harness } = await mountChat();
    await tick(10);
    expect(harness.container.textContent).toContain("Model B");
    expect(harness.container.textContent).toContain("You");
    expect(harness.container.textContent).not.toContain("Model A");
    harness.unmount();
  });

  it("T11: send error banner clears after the next successful send", async () => {
    let call = 0;
    const { harness } = await mountChat({
      handlers: { chat: () => (call++ === 0 ? jsonResponse({ error: { message: "boom" } }, 500) : finishedStream("ok")) },
    });

    await send(harness, "one");
    const alert = await waitFor(() => harness.container.querySelector('[role="alert"]'), "send error alert");
    expect(alert.textContent).toContain("boom");

    await send(harness, "two");
    await waitFor(() => !harness.container.querySelector('[role="alert"]'), "alert cleared");
    harness.unmount();
  });

  it("T12: switching sessions aborts the live stream", async () => {
    globalThis.localStorage.setItem("basic-chat.sessions", JSON.stringify([
      session("s1", "Model A", [{ id: "m1", role: "user", content: "hello a", createdAt: "2026-01-01T00:00:00.000Z" }]),
      session("s2", "Model B", [{ id: "m2", role: "user", content: "hello b", createdAt: "2026-01-01T00:00:01.000Z" }], "2026-01-01T00:00:01.000Z"),
    ]));
    globalThis.localStorage.setItem("basic-chat.activeSessionId", "s2");

    let stream;
    let signal;
    const { harness } = await mountChat({
      handlers: {
        chat: (init) => {
          signal = init.signal;
          stream = openStream();
          return Promise.resolve(stream.response);
        },
      },
    });
    await tick(5);

    await send(harness, "stream me");
    stream.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "tok" } }] })}\n\n`);
    await tick(5);
    expect(signal.aborted).toBe(false);

    const historyBtn = await waitFor(
      () => [...harness.container.querySelectorAll("button")].find((b) => b.textContent.trim() === "History"),
      "History button",
    );
    historyBtn.click();
    const s1 = await waitFor(
      () => [...harness.container.querySelectorAll("button")].find((b) => b.textContent.includes("Chat s1")),
      "Chat s1 entry",
    );
    s1.click();
    await waitFor(() => signal.aborted, "stream aborted");
    expect(signal.aborted).toBe(true);
    harness.unmount();
  });

  it("T13: streaming tokens do not re-persist sessions per token", async () => {
    const origSetItem = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    const setItem = vi.fn(origSetItem);
    globalThis.localStorage.setItem = setItem;

    let stream;
    const { harness } = await mountChat({
      handlers: {
        chat: () => {
          stream = openStream();
          return Promise.resolve(stream.response);
        },
      },
    });

    const sessionsWrites = () => setItem.mock.calls.filter(([k]) => k === "basic-chat.sessions").length;
    await send(harness, "count me");
    const before = sessionsWrites();

    for (let i = 0; i < 10; i++) {
      stream.push(`data: ${JSON.stringify({ choices: [{ delta: { content: `t${i} ` } }] })}\n\n`);
      await tick(2);
    }
    expect(sessionsWrites()).toBe(before); // no writes during streaming

    stream.push("data: [DONE]\n\n");
    stream.close();
    await tick(15);
    expect(sessionsWrites() - before).toBeLessThanOrEqual(2);
    harness.unmount();
    globalThis.localStorage.setItem = origSetItem;
  });

  it("T15: non-image attachments are rejected with a notice", async () => {
    const { harness } = await mountChat();
    const input = harness.container.querySelector('input[type="file"]');
    const file = new File([new Uint8Array([0x25, 0x50])], "doc.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(10);

    const notice = harness.container.querySelector('[role="status"]');
    expect(notice?.textContent).toContain("Only image files are supported.");
    harness.unmount();
  });
});
