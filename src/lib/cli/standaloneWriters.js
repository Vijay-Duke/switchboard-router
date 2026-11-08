// Reuse the dashboard's file writers in the standalone CLI, without starting
// an HTTP server. The CLI build supplies Response.json and an empty local
// catalog in place of NextResponse and SQLite; file and backup logic is shared.
import * as claude from "@/app/api/cli-tools/claude-settings/route.js";
import * as codex from "@/app/api/cli-tools/codex-settings/route.js";
import * as opencode from "@/app/api/cli-tools/opencode-settings/route.js";
import * as droid from "@/app/api/cli-tools/droid-settings/route.js";
import * as grok from "@/app/api/cli-tools/grok-settings/route.js";
import * as deepseek from "@/app/api/cli-tools/deepseek-tui-settings/route.js";
import * as jcode from "@/app/api/cli-tools/jcode-settings/route.js";
import * as cline from "@/app/api/cli-tools/cline-settings/route.js";
import * as kilo from "@/app/api/cli-tools/kilo-settings/route.js";
import * as aider from "@/app/api/cli-tools/aider-settings/route.js";
import * as gemini from "@/app/api/cli-tools/gemini-cli-settings/route.js";
import * as fx from "@/app/api/cli-tools/fx-settings/route.js";
import * as hermes from "@/app/api/cli-tools/hermes-settings/route.js";
import * as pi from "@/app/api/cli-tools/pi-settings/route.js";
import * as openclaw from "@/app/api/cli-tools/openclaw-settings/route.js";
import * as cowork from "@/app/api/cli-tools/cowork-settings/route.js";
import * as codexProfiles from "@/app/api/cli-tools/codex-profiles/route.js";
import { parseTOML } from "confbox";

const routes = { claude, codex, opencode, droid, grok, "deepseek-tui": deepseek,
  jcode, cline, kilo, aider, "gemini-cli": gemini, fx, hermes, pi, openclaw, cowork,
  "codex-profiles": codexProfiles };

export async function invoke(tool, method, body) {
  const handler = routes[tool]?.[method];
  if (!handler) throw new Error(`Unsupported tool operation: ${tool} ${method}`);
  const request = new Request(`http://localhost/api/cli-tools/${tool}-settings?includeConfig=1`, {
    method, ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }),
  });
  const response = await handler(request);
  const data = await response.json();
  if (method === "GET" && tool === "codex" && typeof data.config === "string") data.config = parseTOML(data.config);
  return { success: response.ok && data.success !== false, statusCode: response.status, data,
    ...(!response.ok ? { error: data.error || `Failed to ${method} ${tool} settings` } : {}) };
}
