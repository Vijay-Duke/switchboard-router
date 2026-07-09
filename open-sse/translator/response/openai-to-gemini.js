import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { openaiToAntigravityResponse } from "./openai-to-antigravity.js";

// Gemini-family streaming responses share the same response.candidates envelope.
// Without these registrations, OpenAI-native providers streaming back to a
// Gemini / Gemini CLI / Vertex client returned raw chat.completion.chunk SSE
// (decolua/9router#2398 / PR#2399).
register(FORMATS.OPENAI, FORMATS.GEMINI, null, openaiToAntigravityResponse);
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, null, openaiToAntigravityResponse);
register(FORMATS.OPENAI, FORMATS.VERTEX, null, openaiToAntigravityResponse);
