// @ts-check
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { projectCompletionToClientFormat } from "open-sse/translator/response/completionProjector.js";
import { corsPreflightResponse } from "@/shared/utils/cors.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS(request) {
  return corsPreflightResponse(request);
}

/**
 * Normalize a complete JSON document from handleChat into an Ollama
 * /api/chat response. Non-streaming requests (stream:false), error paths,
 * and bypass/canned replies all come back as application/json — never as
 * OpenAI SSE frames — so the SSE line transform cannot carry their payload
 * and would drop the assistant content (QA-004).
 *
 * @param {Response} response - handleChat response with an application/json body.
 * @param {string} modelName - Model name to echo, matching the streaming path.
 * @returns {Promise<Response>}
 */
async function ollamaNonStreamingResponse(response, modelName) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (payload === null) {
    return new Response(
      JSON.stringify({ model: modelName, message: { role: "assistant", content: "" }, done: true }) + "\n",
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
  }

  // Errors keep their status and body so Ollama clients see the failure —
  // the SSE transform used to mask them as a 200 with an empty message.
  if (!response.ok || payload.error) {
    const headers = { "Content-Type": "application/json" };
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    return new Response(JSON.stringify(payload), { status: response.status, headers });
  }

  // Success: already projected to an Ollama envelope by handleChat
  // (openAICompletionToOllama via projectCompletionToClientFormat).
  if (payload.message && typeof payload.message === "object" && "done" in payload) {
    return new Response(JSON.stringify({ ...payload, model: modelName }) + "\n", {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }

  // OpenAI chat.completion shape (bypass / canned feedback replies) → Ollama envelope.
  if (payload.choices?.[0]) {
    const ollama = projectCompletionToClientFormat(payload, FORMATS.OLLAMA);
    return new Response(JSON.stringify({ ...ollama, model: modelName }) + "\n", {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }

  // Unknown shape — pass through untouched rather than inventing content.
  return new Response(JSON.stringify(payload) + "\n", {
    status: response.status,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

export async function POST(request) {
  await ensureInitialized();

  const clonedReq = request.clone();
  let modelName = "llama3.2";
  try {
    const body = await clonedReq.json();
    modelName = body.model || "llama3.2";
  } catch {}

  const response = await handleChat(request);

  // JSON bodies are complete documents (non-streaming or error), not SSE.
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return ollamaNonStreamingResponse(response, modelName);
  }
  return transformToOllama(response, modelName);
}
