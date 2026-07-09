import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array when it contains text only. Keeping these
// turns as strings avoids sending an unsupported multimodal array to strict
// OpenAI-compatible endpoints while preserving the line boundaries.
export function collapseTextParts(parts) {
  return parts.length > 0 && parts.every((part) =>
    part.type === OPENAI_BLOCK.TEXT && Object.keys(part).every((key) => key === "type" || key === "text")
  )
    ? parts.map((part) => part.text || "").join("\n")
    : parts;
}
