import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
const imageUrl = "data:image/png;base64,aW1hZ2U=";
const pdfData = "data:application/pdf;base64,cGRm";
const call = (id = "call_media") => ({ type: "function_call", call_id: id, name: "inspect", arguments: "{}" });
const responseBody = (output) => ({ input: [
  { role: "user", content: "Inspect the evidence." }, call(),
  { type: "function_call_output", call_id: "call_media", output },
], tools: [{ type: "function", name: "inspect", parameters: { type: "object", properties: {} } }] });
const toClaude = (output) => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-sonnet-4-6", responseBody(output), false, null, "anthropic");
const toolResult = (body) => body.messages.flatMap(m => m.content).find(b => b.type === "tool_result");
describe("Responses multimodal tool history full pipeline", () => {
  it("converts image-only output to a genuine Claude image tool result", () => {
    expect(toolResult(toClaude([{ type: "input_image", image_url: imageUrl }]))).toMatchObject({
      tool_use_id: "call_media", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }],
    });
  });
  it("converts PDF-only output to a genuine Claude document tool result", () => {
    expect(toolResult(toClaude([{ type: "input_file", filename: "evidence.pdf", file_data: pdfData }])).content)
      .toEqual([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } }]);
  });
  it("preserves mixed text, image and PDF output in order", () => {
    const body = toClaude([
      { type: "input_text", text: "See both attachments." },
      { type: "input_image", image_url: "https://example.com/chart.png" },
      { type: "input_file", filename: "evidence.pdf", file_data: pdfData },
    ]);
    expect(toolResult(body).content).toEqual([
      { type: "text", text: "See both attachments." },
      { type: "image", source: { type: "url", url: "https://example.com/chart.png" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
    ]);
    expect(body.messages.flatMap(m => m.content).filter(b => b.type === "tool_use").map(b => b.id)).toEqual(["call_media"]);
  });
  it("preserves string tool output without reinterpreting JSON strings", () => {
    expect(toolResult(toClaude('{"type":"input_image","image_url":"not-media"}')).content)
      .toBe('{"type":"input_image","image_url":"not-media"}');
  });
  it("returns Claude mixed media tool results to Responses as typed output parts", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-4.1", { max_tokens: 256, messages: [
      { role: "user", content: "Inspect." },
      { role: "assistant", content: [{ type: "tool_use", id: "call_media", name: "inspect", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_media", content: [
        { type: "text", text: "Evidence." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
      ] }] },
    ] }, false);
    expect(out.input.find(item => item.type === "function_call_output")).toEqual({
      type: "function_call_output", call_id: "call_media", output: [
        { type: "input_text", text: "Evidence." },
        { type: "input_image", image_url: imageUrl, detail: "auto" },
        { type: "input_file", file_data: pdfData },
      ],
    });
  });
  it("retains uploaded file IDs in tool output during chat to Responses translation", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-4.1", { messages: [
      { role: "assistant", content: null, tool_calls: [{ type: "function", id: "call_media", function: { name: "inspect", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_media", content: [{ type: "file", file: { file_id: "file_uploaded", filename: "evidence.pdf" } }] },
    ] }, false);
    expect(out.input.find(item => item.type === "function_call_output").output).toEqual([
      { type: "input_file", file_id: "file_uploaded", filename: "evidence.pdf" },
    ]);
  });
  it("keeps parallel result IDs and following user media in their original turns", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-sonnet-4-6", { input: [
      { role: "user", content: "Inspect both." }, call("call_one"), call("call_two"),
      { type: "function_call_output", call_id: "call_one", output: [{ type: "input_image", image_url: imageUrl }] },
      { type: "function_call_output", call_id: "call_two", output: [{ type: "input_file", file_data: pdfData }] },
      { role: "user", content: [{ type: "input_image", image_url: "https://example.com/followup.png" }] },
    ] }, false, null, "anthropic");
    const blocks = out.messages.flatMap(m => m.content);
    expect(blocks.filter(b => b.type === "tool_use").map(b => b.id)).toEqual(["call_one", "call_two"]);
    expect(blocks.filter(b => b.type === "tool_result").map(b => [b.tool_use_id, b.content[0].type]))
      .toEqual([["call_one", "image"], ["call_two", "document"]]);
    expect(blocks.at(-1)).toEqual({ type: "image", source: { type: "url", url: "https://example.com/followup.png" } });
  });
  it("round trips media payloads and call IDs through Claude without inventing a result", () => {
    const original = [
      { type: "input_text", text: "Evidence." },
      { type: "input_image", image_url: imageUrl },
      { type: "input_file", file_data: pdfData },
    ];
    const claude = toClaude(original);
    const responses = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-4.1", claude, false);
    const outputs = responses.input.filter(item => item.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe("call_media");
    expect(outputs[0].output).toEqual([
      original[0], { ...original[1], detail: "auto" }, original[2],
    ]);
  });

  it("keeps strict Chat Completions tool results as text at the provider boundary", () => {
    const output = [{ type: "input_image", image_url: imageUrl }, { type: "input_file", file_data: pdfData }];
    const chat = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-4.1", responseBody(output), false);
    expect(chat.messages.find(m => m.role === "tool").content).toBe(JSON.stringify(output));
  });

});
