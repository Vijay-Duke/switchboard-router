// @vitest-environment happy-dom
// Behavioral regression tests for the shared Modal/Drawer dialog contract:
// role=dialog semantics, initial focus, Tab/Shift+Tab trapping, Escape close,
// and focus return to the opener (QA-003, QA-009, QA-012, QA-015, QA-032).
// JSX is avoided (React.createElement) because the vitest config only
// transforms .js without a JSX loader.

import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Modal, { ConfirmModal } from "@/shared/components/Modal";
import Drawer from "@/shared/components/Drawer";
import { getDialogFocusable, getNextTabTarget } from "@/shared/hooks/useDialog";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;
let opener = null;

function mount(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(element));
}

function pressKey(key, { shiftKey = false } = {}) {
  const target = document.activeElement || document;
  // Escape closes via React state, so dispatch inside act to flush the update.
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
    );
  });
}

function ModalHarness(props) {
  const [open, setOpen] = React.useState(true);
  return h(Modal, { isOpen: open, onClose: () => setOpen(false), ...props });
}

function DrawerHarness(props) {
  const [open, setOpen] = React.useState(true);
  return h(Drawer, { isOpen: open, onClose: () => setOpen(false), ...props });
}

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  opener?.remove();
  opener = null;
  document.body.style.overflow = "";
});

function makeOpener() {
  opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.appendChild(opener);
  opener.focus();
  return opener;
}

describe("Modal dialog semantics", () => {
  it("exposes role=dialog, aria-modal, and aria-labelledby pointing at the title", () => {
    mount(h(Modal, { isOpen: true, onClose: () => {}, title: "Create API Key" }, h("p", null, "body")));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = dialog.querySelector(`#${CSS.escape(labelledBy)}`);
    expect(heading).not.toBeNull();
    expect(heading.textContent).toBe("Create API Key");
  });

  it("uses the aria-label prop when there is no title", () => {
    mount(h(Modal, { isOpen: true, onClose: () => {}, "aria-label": "Quick picker" }, h("p", null, "body")));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog.getAttribute("aria-label")).toBe("Quick picker");
    expect(dialog.getAttribute("aria-labelledby")).toBeNull();
    expect(dialog.querySelector("h2")).toBeNull();
  });

  it("moves initial focus to the first focusable element on open", () => {
    const openerBtn = makeOpener();
    mount(
      h(
        Modal,
        { isOpen: true, onClose: () => {}, "aria-label": "Create Combo", showTrafficLights: false },
        h("input", { "aria-label": "Name", id: "combo-name" }),
        h("button", { id: "combo-save" }, "Save")
      )
    );
    expect(document.activeElement).toBe(document.getElementById("combo-name"));
    expect(document.activeElement).not.toBe(openerBtn);
  });

  it("focuses the dialog container when nothing inside is focusable", () => {
    mount(
      h(
        Modal,
        { isOpen: true, onClose: () => {}, "aria-label": "Info", showTrafficLights: false },
        h("p", null, "read-only text")
      )
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(document.activeElement).toBe(dialog);
  });

  it("traps Tab and Shift+Tab inside the dialog", () => {
    mount(
      h(
        Modal,
        {
          isOpen: true,
          onClose: () => {},
          "aria-label": "Edit",
          showTrafficLights: false,
          footer: h("button", { id: "f-cancel" }, "Cancel"),
        },
        h("input", { "aria-label": "A", id: "in-a" }),
        h("input", { "aria-label": "B", id: "in-b" })
      )
    );
    const a = document.getElementById("in-a");
    const b = document.getElementById("in-b");
    const cancel = document.getElementById("f-cancel");

    a.focus();
    pressKey("Tab");
    // Mid-list Tab is not intercepted (happy-dom has no native tab order, so
    // focus simply stays put instead of moving to b).
    expect(document.activeElement).toBe(a);

    cancel.focus();
    pressKey("Tab");
    expect(document.activeElement).toBe(a);

    a.focus();
    pressKey("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it("closes on Escape and returns focus to the opener", () => {
    const openerBtn = makeOpener();
    mount(
      h(
        ModalHarness,
        { "aria-label": "Shutdown", showTrafficLights: false },
        h("button", { id: "confirm" }, "Confirm")
      )
    );
    expect(document.activeElement).toBe(document.getElementById("confirm"));

    pressKey("Escape");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(openerBtn);
  });

  it("locks page scroll while open and restores it on close", () => {
    document.body.style.overflow = "auto";
    mount(h(ModalHarness, { "aria-label": "Info", showTrafficLights: false }, h("p", null, "text")));
    expect(document.body.style.overflow).toBe("hidden");
    pressKey("Escape");
    expect(document.body.style.overflow).toBe("auto");
  });

  it("keeps only the top-most dialog on the keyboard when dialogs stack", () => {
    function NestedHarness() {
      const [outer, setOuter] = React.useState(true);
      const [inner, setInner] = React.useState(false);
      return h(
        React.Fragment,
        null,
        h(
          Modal,
          { isOpen: outer, onClose: () => setOuter(false), "aria-label": "Outer", showTrafficLights: false },
          h("input", { "aria-label": "Outer field", id: "outer-input" }),
          h("button", { id: "open-inner", onClick: () => setInner(true) }, "Open inner")
        ),
        h(
          Modal,
          { isOpen: inner, onClose: () => setInner(false), "aria-label": "Inner", showTrafficLights: false },
          h("input", { "aria-label": "Inner field", id: "inner-input" })
        )
      );
    }
    mount(h(NestedHarness));
    expect(document.activeElement).toBe(document.getElementById("outer-input"));

    act(() => {
      // Focus the trigger first: happy-dom's click() does not move focus, and
      // the dialog must capture the focused element as its opener.
      document.getElementById("open-inner").focus();
      document.getElementById("open-inner").click();
    });
    expect(document.activeElement).toBe(document.getElementById("inner-input"));

    // Escape closes only the inner dialog and returns focus to its trigger.
    pressKey("Escape");
    expect(container.querySelectorAll('[role="dialog"]').length).toBe(1);
    expect(document.activeElement).toBe(document.getElementById("open-inner"));

    // The remaining outer dialog still owns Escape and the focus trap.
    pressKey("Escape");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("ConfirmModal inherits dialog semantics", () => {
    mount(
      h(ConfirmModal, {
        isOpen: true,
        onClose: () => {},
        onConfirm: () => {},
        title: "Delete key",
        message: "This cannot be undone.",
      })
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  });
});

describe("Drawer dialog semantics", () => {
  it("exposes role=dialog, aria-modal, and aria-labelledby pointing at the title", () => {
    mount(h(Drawer, { isOpen: true, onClose: () => {}, title: "Request Details" }, h("p", null, "body")));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(dialog.querySelector(`#${CSS.escape(labelledBy)}`).textContent).toBe("Request Details");
  });

  it("moves initial focus into the drawer and traps Tab", () => {
    mount(
      h(
        Drawer,
        { isOpen: true, onClose: () => {}, title: "Request Details" },
        h("button", { id: "d-first" }, "First"),
        h("button", { id: "d-last" }, "Last")
      )
    );
    // First focusable in the drawer is the header close button.
    const closeBtn = container.querySelector('[aria-label="Close"]');
    expect(document.activeElement).toBe(closeBtn);

    document.getElementById("d-last").focus();
    pressKey("Tab");
    expect(document.activeElement).toBe(closeBtn);
  });

  it("closes on Escape and returns focus to the opener", () => {
    const openerBtn = makeOpener();
    mount(h(DrawerHarness, { title: "Request Details" }, h("p", null, "details")));
    pressKey("Escape");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(openerBtn);
  });
});

describe("dialog focus helpers", () => {
  it("getNextTabTarget wraps in both directions", () => {
    const [a, b, c] = [{}, {}, {}];
    expect(getNextTabTarget([a, b, c], c, false)).toBe(a);
    expect(getNextTabTarget([a, b, c], a, true)).toBe(c);
    expect(getNextTabTarget([a, b, c], b, false)).toBeNull();
    expect(getNextTabTarget([a, b, c], b, true)).toBeNull();
    expect(getNextTabTarget([a, b, c], null, false)).toBe(a);
    expect(getNextTabTarget([a, b, c], null, true)).toBe(c);
    expect(getNextTabTarget([], a, false)).toBeNull();
  });

  it("getDialogFocusable filters hidden elements", () => {
    const visible = { hasAttribute: () => false };
    const hidden = { hasAttribute: (name) => name === "hidden" };
    const fakeRoot = { querySelectorAll: () => [visible, hidden] };
    expect(getDialogFocusable(fakeRoot)).toEqual([visible]);
    expect(getDialogFocusable(null)).toEqual([]);
  });
});
