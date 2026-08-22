"use client";

import { useEffect, useRef } from "react";

// Stack of currently open dialog elements. Only the top-most dialog owns the
// keyboard, so layered overlays (e.g. ModelSelectModal over ComboFormModal)
// trap focus and close on Escape one layer at a time.
const dialogStack = [];

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Keyboard-focusable elements inside a dialog root, in DOM order.
 * Hidden elements are filtered out.
 */
export function getDialogFocusable(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute && el.hasAttribute("hidden")) return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility();
    return true;
  });
}

/**
 * Wrap target for a Tab / Shift+Tab keystroke, or null when the browser's
 * default tab order is already correct.
 */
export function getNextTabTarget(focusables, activeElement, backwards) {
  if (!focusables.length) return null;
  const index = focusables.indexOf(activeElement);
  if (index === -1) return backwards ? focusables[focusables.length - 1] : focusables[0];
  if (backwards) return index === 0 ? focusables[focusables.length - 1] : null;
  return index === focusables.length - 1 ? focusables[0] : null;
}

/**
 * Dialog semantics shared by Modal and Drawer: moves initial focus into the
 * dialog, traps Tab/Shift+Tab inside it, closes it on Escape (top-most only),
 * locks page scroll, and returns focus to the opener on close.
 *
 * The returned ref must land on the element carrying role="dialog" together
 * with tabIndex={-1}.
 */
export function useDialog({ isOpen, onClose }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!isOpen) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    dialogStack.push(dialog);

    // Remember the opener so focus can be restored, then move focus in
    // (first focusable element, else the dialog container itself). Focus is
    // left alone when something inside the dialog already took it (e.g. a
    // child input with autoFocus).
    const opener = document.activeElement;
    if (!dialog.contains(opener)) {
      (getDialogFocusable(dialog)[0] || dialog).focus();
    }

    const isTop = () => dialogStack[dialogStack.length - 1] === dialog;

    const handleKeyDown = (e) => {
      if (!isTop()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (e.key === "Tab") {
        const focusables = getDialogFocusable(dialog);
        if (!focusables.length) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const target = getNextTabTarget(focusables, document.activeElement, e.shiftKey);
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const index = dialogStack.indexOf(dialog);
      if (index !== -1) dialogStack.splice(index, 1);
      // Only the last dialog to close releases the scroll lock.
      if (!dialogStack.length) document.body.style.overflow = previousOverflow;
      if (opener && opener.isConnected && typeof opener.focus === "function") {
        opener.focus();
      }
    };
  }, [isOpen]);

  return dialogRef;
}
