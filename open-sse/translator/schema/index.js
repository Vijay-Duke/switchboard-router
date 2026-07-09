// Translator schema barrel — pure data enums (roles, blocks). No logic here.
export { ROLE, GEMINI_ROLE } from "./roles.js";
export {
  OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM,
  VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES,
} from "./blocks.js";
export {
  OPENAI_FINISH,
  CLAUDE_STOP,
  GEMINI_FINISH,
  GEMINI_ERROR_FINISH_REASONS,
  GEMINI_CONTENT_FILTER_FINISH_REASONS,
} from "./finishReasons.js";
export { MODEL_FALLBACK, DEFAULT_IMAGE_MIME } from "./defaults.js";
