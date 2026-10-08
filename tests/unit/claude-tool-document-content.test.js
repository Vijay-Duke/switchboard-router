import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ROLE, CLAUDE_BLOCK } from "../../open-sse/translator/schema/index.js";

const model = "claude-sonnet-4-6";
const pdf = { type: CLAUDE_BLOCK.DOCUMENT, source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } };
const file = (mime, data) => ({ type: "file", file: { file_data: `data:${mime};base64,${data}` } });
const input = (content, isError = false) => ({ messages: [
  { role: ROLE.ASSISTANT, content: null, tool_calls: [{ id: "call_file", type: "function", function: { name: "Read", arguments: "{}" } }] },
  { role: ROLE.TOOL, tool_call_id: "call_file", content, is_error: isError },
] });
const convert = (body) => translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, model, body, false, null, "anthropic");
const toolResult = (body) => convert(body).messages.flatMap(message => message.content).find(block => block.type === CLAUDE_BLOCK.TOOL_RESULT);

describe("Claude tool result file content", () => {
  it("converts an OpenAI PDF file reply into a document instead of an empty result", () => {
    expect(toolResult(input([file("application/pdf", pdf.source.data)])).content).toEqual([pdf]);
  });

  it("retains mixed tool text, image and PDF in order along with its error status", () => {
    const text = { type: CLAUDE_BLOCK.TEXT, text: "Partial report" };
    const image = { type: CLAUDE_BLOCK.IMAGE, source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } };
    const result = toolResult(input([
      text,
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      file("application/pdf", pdf.source.data),
    ], true));
    expect(result.content).toEqual([text, image, pdf]);
    expect(result.is_error).toBe(true);
    expect(result.tool_use_id).toBe("call_file");
  });

  it("decodes an attached text file in a tool reply", () => {
    expect(toolResult(input([file("text/plain", Buffer.from("actual file output").toString("base64"))])).content)
      .toEqual([{ type: CLAUDE_BLOCK.TEXT, text: "actual file output" }]);
  });

  it("retains a native document block including its title and source metadata", () => {
    const titled = { ...pdf, title: "Read output", context: "An attached report", citations: { enabled: true } };
    expect(toolResult(input([titled])).content).toEqual([titled]);
  });

  it("preserves a PDF tool result across the Claude/OpenAI bridge", () => {
    const original = { messages: [
      { role: ROLE.ASSISTANT, content: [{ type: CLAUDE_BLOCK.TOOL_USE, id: "call_file", name: "Read", input: {} }] },
      { role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: "call_file", content: [pdf], is_error: true }] },
    ] };
    const pivot = claudeToOpenAIRequest(model, original, false);
    expect(toolResult(pivot)).toMatchObject({ content: [pdf], is_error: true });
  });

  it("keeps an explicit omission note for an unsupported tool-file type", () => {
    expect(toolResult(input([file("video/mp4", "YWJj")])).content)
      .toEqual([{ type: CLAUDE_BLOCK.TEXT, text: "[file omitted: video/mp4]" }]);
  });
});
