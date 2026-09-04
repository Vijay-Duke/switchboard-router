import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { openaiToGeminiBase } from "./openai-to-gemini.js";
import { DEFAULT_THINKING_VERTEX_SIGNATURE } from "../../config/defaultThinkingSignature.js";

/**
 * Post-process a Gemini-format body for Vertex AI compatibility:
 *
 * 1. Replace all synthetic thoughtSignatures with Vertex-native signature.
 * 2. Strip `id` from functionCall and functionResponse (Vertex rejects these).
 *
 * Known limitation (order-pairing): stripping ids means parallel same-name
 * calls can only be re-paired with their results by position. Turn order is
 * preserved end-to-end by this translator, so pairing holds as long as neither
 * side reorders, retries partially, or drops a result on the Vertex leg.
 */
function postProcessForVertex(body) {
  if (!body?.contents) return body;

  for (const turn of body.contents) {
    if (!Array.isArray(turn.parts)) continue;

    for (const part of turn.parts) {
      // Replace any synthetic signature with Vertex-native one
      if (part.thoughtSignature !== undefined) {
        part.thoughtSignature = DEFAULT_THINKING_VERTEX_SIGNATURE;
      }
      // Strip id from functionCall
      if (part.functionCall && "id" in part.functionCall) {
        delete part.functionCall.id;
      }
      // Strip id from functionResponse
      if (part.functionResponse && "id" in part.functionResponse) {
        delete part.functionResponse.id;
      }
    }
  }

  return body;
}

export function openaiToVertexRequest(model, body, stream) {
  // NOTE: the 4th arg of openaiToGeminiBase is `signature` (a string) — never
  // pass the credentials object here (auth-material-shaped values would sit in
  // thoughtSignature until postProcessForVertex overwrites them).
  const gemini = openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_VERTEX_SIGNATURE);
  return postProcessForVertex(gemini);
}

register(FORMATS.OPENAI, FORMATS.VERTEX, openaiToVertexRequest, null);
