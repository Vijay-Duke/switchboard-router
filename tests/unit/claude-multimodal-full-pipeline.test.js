import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ROLE, CLAUDE_BLOCK } from "../../open-sse/translator/schema/index.js";

const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const pdfData = "JVBERi0xLjQK";
const openaiImage = () => ({ type: "image_url", image_url: { url: `data:image/png;base64,${imageData}` } });
const openaiPdf = () => ({ type: "file", file: { file_data: `data:application/pdf;base64,${pdfData}` } });
const claudeImage = () => ({ type: CLAUDE_BLOCK.IMAGE, source: { type: "base64", media_type: "image/png", data: imageData } });
const claudePdf = () => ({ type: CLAUDE_BLOCK.DOCUMENT, title: "Report", source: { type: "base64", media_type: "application/pdf", data: pdfData } });
const translate = (messages, sourceFormat = FORMATS.OPENAI) => translateRequest(
  sourceFormat, FORMATS.CLAUDE, "claude-sonnet-4-6", { messages }, false, null, "anthropic",
);

describe("Claude media turns through full request preparation", () => {
  it.each([
    ["image", openaiImage, CLAUDE_BLOCK.IMAGE, imageData],
    ["PDF", openaiPdf, CLAUDE_BLOCK.DOCUMENT, pdfData],
  ])("retains a first user turn containing only an OpenAI %s", (_name, part, type, data) => {
    const output = translate([{ role: ROLE.USER, content: [part()] }]);
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0].role).toBe(ROLE.USER);
    expect(output.messages[0].content).toHaveLength(1);
    expect(output.messages[0].content[0]).toMatchObject({ type, source: { data } });
  });

  it.each([["image", claudeImage], ["PDF", claudePdf]])("retains a native Claude %s with no accompanying text", (_name, part) => {
    const block = part();
    const output = translate([{ role: ROLE.USER, content: [block] }], FORMATS.CLAUDE);
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0].content).toEqual([block]);
  });

  it("retains both attachment turns in a mixed conversation history", () => {
    const output = translate([
      { role: ROLE.USER, content: "Please review my attachments" },
      { role: ROLE.ASSISTANT, content: "Send the image first" },
      { role: ROLE.USER, content: [openaiImage()] },
      { role: ROLE.ASSISTANT, content: "Now send the report" },
      { role: ROLE.USER, content: [openaiPdf()] },
      { role: ROLE.ASSISTANT, content: "I have both" },
      { role: ROLE.USER, content: "Compare the report and image" },
    ]);
    expect(output.messages).toHaveLength(7);
    expect(output.messages[2].content[0]).toMatchObject({ type: CLAUDE_BLOCK.IMAGE, source: { data: imageData } });
    expect(output.messages[4].content[0]).toMatchObject({ type: CLAUDE_BLOCK.DOCUMENT, source: { data: pdfData } });
  });

  it("still filters genuinely empty native user turns while keeping a media turn", () => {
    const output = translate([
      { role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TEXT, text: "  " }] },
      { role: ROLE.USER, content: [claudeImage()] },
    ], FORMATS.CLAUDE);
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0].content).toEqual([claudeImage()]);
  });
});
