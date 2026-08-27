"use client";
// @ts-check

import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { reportClientError } from "@/shared/utils/clientFeedback";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

function colorLine(line) {
  const match = line.match(/\[(\w+)\]/g);
  const levelTag = match ? match[1]?.replace(/\[|\]/g, "") : null;
  const color = LOG_LEVEL_COLORS[levelTag] || "text-green-400";
  return <span className={color}>{line}</span>;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [retry, setRetry] = useState(0);
  const logRef = useRef(null);
  const esRef = useRef(null);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      reportClientError("Failed to clear console logs:", err);
    }
  };

  // QA-011: surface a visible disconnected state with a reconnect affordance.
  // The effect re-runs when `retry` changes so Reconnect can force a new stream.
  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setStreamError(false);
    };

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "init") {
          setLogs(Array.isArray(msg.logs) ? msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines) : []);
        } else if (msg.type === "line") {
          setLogs((prev) => {
            const next = [...prev, msg.line];
            return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
          });
        } else if (msg.type === "lines") {
          setLogs((prev) => {
            const next = [...prev, ...(Array.isArray(msg.lines) ? msg.lines : [])];
            return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
          });
        } else if (msg.type === "clear") {
          setLogs([]);
        }
      } catch (err) {
        reportClientError("Failed to parse console log SSE message:", err);
      }
    };

    es.onerror = () => {
      setConnected(false);
      setStreamError(true);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [retry]);

  const handleReconnect = () => {
    esRef.current?.close();
    setStreamError(false);
    setConnected(false);
    setRetry((n) => n + 1);
  };

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const { copied, copy } = useCopyToClipboard();

  const handleCopyLogs = () => {
    copy(logs.join("\n"), "console_logs");
  };

  return (
    <div className="">
      <Card>
        <div className="flex items-center justify-end gap-2 px-4 pt-3 pb-2">
          <span
            className={`text-xs font-mono mr-auto ${connected ? "text-green-500" : "text-text-muted"}`}
            role="status"
            aria-live="polite"
          >
            {connected ? "connected" : streamError ? "disconnected" : "connecting"}
          </span>
          {streamError && (
            <Button size="sm" variant="outline" icon="refresh" onClick={handleReconnect}>
              Reconnect
            </Button>
          )}
          {logs.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              icon={copied === "console_logs" ? "check" : "content_copy"}
              onClick={handleCopyLogs}
            >
              {copied === "console_logs" ? "Copied" : "Copy Logs"}
            </Button>
          )}
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
            Clear
          </Button>
        </div>
        {streamError && (
          <div
            role="alert"
            className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500"
          >
            <span className="material-symbols-outlined text-[16px] leading-none mt-0.5">error</span>
            <span>
              Console stream disconnected — the log view is paused and new logs are not being
              received.
            </span>
          </div>
        )}
        <div
          ref={logRef}
          className="bg-black rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
          aria-label="Console log stream"
        >
          {logs.length === 0 ? (
            <span className="text-text-muted">
              {streamError ? "No console logs received yet (disconnected)." : "No console logs yet."}
            </span>
          ) : (
            <div className="space-y-0.5">
              {logs.map((line, i) => (
                <div key={i}>{colorLine(line)}</div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
