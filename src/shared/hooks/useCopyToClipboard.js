"use client";

import { useState, useCallback, useEffect, useRef } from "react";

/**
 * Hook for copy to clipboard with feedback
 * @param {number} resetDelay - Time in ms before resetting copied state (default: 2000)
 * @returns {{ copied: string|null, copy: (text: string, id?: string) => Promise<void> }}
 */
export function useCopyToClipboard(resetDelay = 2000) {
  const [copied, setCopied] = useState(null);
  const timeoutRef = useRef(null);

  const copy = useCallback(async (text, id = "default") => {
    const write = async () => {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) throw new Error("Clipboard copy was rejected");
        } finally {
          document.body.removeChild(textarea);
        }
      }
    };
    try {
      await write();
      setCopied(id);

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setCopied(null);
      }, resetDelay);
    } catch {
      // clipboard write failed; do not set copied state
    }
  }, [resetDelay]);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  return { copied, copy };
}
