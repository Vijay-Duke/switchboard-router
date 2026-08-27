// @ts-check
import { handleChat } from "@/sse/handlers/chat.js";
import { corsPreflightResponse } from "@/shared/utils/cors.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight — reflect the requesting Origin (gateway serves
 * browser clients on arbitrary origins; QA-023).
 */
export async function OPTIONS(request) {
  return corsPreflightResponse(request);
}

/**
 * POST /v1/messages - Claude format (auto convert via handleChat)
 */
export async function POST(request) {
  await ensureInitialized();
  return await handleChat(request);
}
