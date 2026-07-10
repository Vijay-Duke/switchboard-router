// @ts-check
import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/appUpdater";

// Shutdown app to release file locks for manual update
export async function POST() {
  const response = NextResponse.json({ success: true, message: "Shutting down for manual update..." });

  setTimeout(() => {
    killAppProcesses()
      .catch(() => {})
      .finally(() => process.kill(process.pid, "SIGTERM"));
  }, 100);

  return response;
}
