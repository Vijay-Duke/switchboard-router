// @vitest-environment happy-dom
// D5: request-log rows carry lowercase statuses ("ok", "success", "error",
// "pending") — the classifier must match case-insensitively.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import RequestLogger from "@/shared/components/RequestLogger";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

function row(status) {
  return `2026-01-01 | gpt-4 | openai | acct | 10 | 20 | ${status}`;
}

async function mount(statuses) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(statuses.map(row)) }),
    ),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(RequestLogger, null));
  });
}

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

function statusCell(status) {
  const cells = [...container.querySelectorAll("tbody td:last-child")];
  return cells.find((td) => td.textContent === status);
}

describe("request logger status classes (D5)", () => {
  it("marks ok/success rows green and error/failed rows red", async () => {
    await mount(["ok", "success", "error", "failed", "pending"]);

    expect(statusCell("ok").className).toContain("text-success");
    expect(statusCell("success").className).toContain("text-success");
    expect(statusCell("error").className).toContain("text-error");
    expect(statusCell("failed").className).toContain("text-error");
  });

  it("marks pending rows with the pulsing style, not success/error", async () => {
    await mount(["pending"]);

    const cell = statusCell("pending");
    expect(cell.className).toContain("animate-pulse");
    expect(cell.className).not.toContain("text-success");
    expect(cell.className).not.toContain("text-error");
  });
});
