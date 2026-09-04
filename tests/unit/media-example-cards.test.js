// @vitest-environment happy-dom
// Behavioral regression tests for media-providers example cards (round-2 T92-T98):
// T92 embedding endpoint placeholder, T93 embedding format robustness,
// T94 stale connection pin across provider switch, T95 non-b64 image response,
// T96 params-gated fields default visibility, T97 STT non-string error body,
// T98 TTS blob URL revocation. React.createElement (no JSX loader in tests/).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/image", () => ({
  default: (props) => h("img", { src: props.src, alt: props.alt, width: props.width, height: props.height }),
}));

import { EmbeddingExampleCard } from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/EmbeddingExampleCard";
import { GenericExampleCard } from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/GenericExampleCard";
import { SttExampleCard } from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/SttExampleCard";
import { TtsExampleCard } from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/TtsExampleCard";

const jsonResponse = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: () => Promise.resolve(data),
  text: () => Promise.resolve(JSON.stringify(data)),
  blob: () => Promise.resolve(new Blob(["x"], { type: "audio/mpeg" })),
  headers: { get: () => "application/json" },
});

let root = null;
let container = null;
let fetchMock = null;

function mount(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(element));
}

async function flush() {
  await act(async () => {});
}

function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelectValue(el, value) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickRun() {
  const run = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Run"));
  expect(run, "Run button rendered").not.toBeNull();
  act(() => {
    run.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function lastCall(urlPart) {
  return fetchMock.mock.calls.filter(([u]) => String(u).includes(urlPart)).pop();
}

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(jsonResponse({})));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EmbeddingExampleCard", () => {
  it("T92: endpoint placeholder is the default gateway origin, not next() origin", async () => {
    mount(h(EmbeddingExampleCard, { providerId: "openai" }));
    await flush();

    const endpoint = container.querySelector("#embedding-example-endpoint");
    expect(endpoint).not.toBeNull();
    expect(endpoint.getAttribute("placeholder")).toBe("http://127.0.0.1:20128");
  });

  it("T93: formats long vectors without crashing on null/string entries", async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(url === "/api/v1/embeddings"
        ? jsonResponse({ data: [{ embedding: [0.123456789, null, "abc", 4, 5, 6] }] })
        : jsonResponse({})));
    mount(h(EmbeddingExampleCard, { providerId: "openai" }));
    await flush();

    setNativeValue(container.querySelector("#embedding-example-key"), "sk-test");
    clickRun();
    await flush();

    const text = container.textContent;
    expect(text).toContain("0.123457");
    expect(text).toContain("abc");
    expect(text).toContain("6 dims)");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("GenericExampleCard", () => {
  it("T96: model without params still shows standard options (Size); params list hides undeclared ones", async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(url === "/api/providers/client"
        ? jsonResponse({ connections: [{ id: "conn-1", provider: "openai", isActive: true }] })
        : jsonResponse({})));

    // antigravity image model declares no params -> every standard field must show
    mount(h(GenericExampleCard, { providerId: "antigravity", kind: "image" }));
    await flush();
    expect(container.querySelector("#generic-example-size")).not.toBeNull();

    // openai gpt-image-1 params: n/size/quality/response_format -> background hidden
    mount(h(GenericExampleCard, { providerId: "openai", kind: "image" }));
    await flush();
    expect(container.querySelector("#generic-example-size")).not.toBeNull();
    expect(container.querySelector("#generic-example-background")).toBeNull();
  });

  it("T94: pinned connection is dropped when providerId changes (no stale x-connection-id header)", async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(url === "/api/providers/client"
        ? jsonResponse({ connections: [{ id: "conn-1", provider: "openai", isActive: true }] })
        : jsonResponse({})));

    mount(h(GenericExampleCard, { providerId: "openai", kind: "image" }));
    await flush();

    const pin = container.querySelector("#generic-example-connection");
    expect(pin).not.toBeNull();
    setSelectValue(pin, "conn-1");

    // Route navigation reuses the component with a new providerId
    await act(async () => {
      root.render(h(GenericExampleCard, { providerId: "antigravity", kind: "image" }));
    });
    await flush();

    setNativeValue(container.querySelector("#generic-example-key"), "sk-test");
    clickRun();
    await flush();

    const call = lastCall("/api/v1/images/generations");
    expect(call).toBeDefined();
    expect(call[1].headers["x-connection-id"]).toBeUndefined();
  });

  it("T95: revised_prompt-only response renders without crash and no Download link", async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(url === "/api/v1/images/generations"
        ? jsonResponse({ data: [{ revised_prompt: "a fluffy dog" }] })
        : jsonResponse({})));

    mount(h(GenericExampleCard, { providerId: "openai", kind: "image" }));
    await flush();

    setNativeValue(container.querySelector("#generic-example-key"), "sk-test");
    clickRun();
    await flush();

    expect(container.textContent).toContain("a fluffy dog");
    expect(container.querySelector("a[download]")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("SttExampleCard", () => {
  it("T97: non-string error body surfaces 'HTTP 500', not [object Object]", async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(url === "/api/v1/audio/transcriptions"
        ? jsonResponse({ error: { code: 123 } }, { ok: false, status: 500 })
        : jsonResponse({})));

    mount(h(SttExampleCard, { providerId: "openai" }));
    await flush();

    setNativeValue(container.querySelector("#stt-example-key"), "sk-test");

    const fileInput = container.querySelector("#stt-example-audio");
    const fakeFile = new Blob(["audio-bytes"], { type: "audio/wav" });
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });
    act(() => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    clickRun();
    await flush();

    const alert = container.querySelector('[role="alert"], .text-red-600');
    expect(alert).not.toBeNull();
    expect(container.textContent).toContain("HTTP 500");
    expect(container.textContent).not.toContain("[object Object]");
  });
});

describe("TtsExampleCard", () => {
  it("T98: previous blob URL is revoked between runs and on unmount", async () => {
    let urlSeq = 0;
    const create = vi.fn(() => `blob:mock-${++urlSeq}`);
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));

    fetchMock.mockImplementation((url) =>
      Promise.resolve(url.includes("/api/v1/audio/speech")
        ? jsonResponse({ audio: "AAAA" })
        : jsonResponse({})));

    mount(h(TtsExampleCard, { providerId: "openai" }));
    await flush();

    setNativeValue(container.querySelector("#tts-example-key"), "sk-test");
    clickRun();
    await flush();

    clickRun();
    await flush();

    expect(create).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("blob:mock-1");

    act(() => root.unmount());
    root = null;
    expect(revoke).toHaveBeenCalledWith("blob:mock-2");
  });
});
