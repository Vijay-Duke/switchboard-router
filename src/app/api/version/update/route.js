// @ts-check
import { NextResponse } from "next/server";
import { killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";

export async function POST() {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      { success: false, message: "Update is only available in production build (switchboard CLI)" },
      { status: 403 }
    );
  }

  // Start the detached updater before stopping the launcher. Killing the CLI
  // parent also terminates this server, so awaiting cleanup here can prevent
  // the updater from ever being spawned.
  spawnUpdaterAndExit();
  setTimeout(() => { killAppProcesses().catch(() => {}); }, 100);

  return NextResponse.json({ success: true, message: "Updater started. This app will exit shortly." });
}
