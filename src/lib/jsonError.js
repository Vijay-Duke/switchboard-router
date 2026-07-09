import { NextResponse } from "next/server";

export function safeErrorMessage(err, fallback = "Unexpected error") {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}

export function jsonError(status, message) {
  return NextResponse.json({ error: safeErrorMessage(message) }, { status });
}
