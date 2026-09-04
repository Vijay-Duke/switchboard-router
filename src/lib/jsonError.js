import { NextResponse } from "next/server";

export function safeErrorMessage(err, fallback = "Unexpected error") {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}

export function jsonError(status, message) {
  // A raw Error on a 5xx must never echo driver internals to the UI: log it
  // server-side and return a static generic. Callers that pass a string chose
  // that message deliberately (e.g. sudo/MITM failures the operator must see).
  if (status >= 500 && message instanceof Error) {
    console.error("[API ERROR]", message.stack || message.message);
    return NextResponse.json({ error: "Unexpected error" }, { status });
  }
  return NextResponse.json({ error: safeErrorMessage(message) }, { status });
}
