// @ts-check
import { handleChat } from "@/sse/handlers/chat.js";
import { corsPreflightResponse } from "@/shared/utils/cors.js";

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

export async function POST(request) {  
  // Fallback to local handling
  await ensureInitialized();
  
  return await handleChat(request);
}
