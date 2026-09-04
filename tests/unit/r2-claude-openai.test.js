/** Round-2 request-translator findings X32–X36 (claude-to-openai). */
import { describe, it, expect } from "vitest";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";

const PDF_B64 = "JVBERi0xLjQK";

describe("X32 document blocks", () => {
  it("base64 PDF becomes a file block", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [{
        role: "user",
        content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_B64 } }],
      }],
    }, true);
    expect(out.messages.length).toBeGreaterThan(0);
    const file = JSON.stringify(out.messages).includes('"type":"file"');
    expect(file).toBe(true);
    expect(JSON.stringify(out.messages)).toContain("application/pdf");
  });
  it("URL document becomes a note, not []", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [{
        role: "user",
        content: [{ type: "document", source: { type: "url", url: "https://x/d.pdf" } }],
      }],
    }, true);
    expect(out.messages.length).toBeGreaterThan(0);
  });
  it("document inside tool_result survives", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_B64 } }],
          }],
        },
      ],
    }, true);
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool.content)).toContain("application/pdf");
  });
});

describe("X33 stop / top mappings", () => {
  it("stop_sequences → stop, top_p/top_k pass through", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["END"],
      top_p: 0.4,
      top_k: 5,
    }, true);
    expect(out.stop).toEqual(["END"]);
    expect(out.top_p).toBe(0.4);
    expect(out.top_k).toBe(5);
  });
});

describe("X34 co-located text first", () => {
  it("text message precedes tool messages", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "context" },
          { type: "tool_result", tool_use_id: "t1", content: "r" },
        ],
      }],
    }, true);
    expect(out.messages[0].role).toBe("user");
    expect(out.messages[0].content).toContain("context");
    expect(out.messages[1].role).toBe("tool");
  });
});

describe("X35 missing tool stub is empty", () => {
  it("assistant tool_call without a following tool message yields content ''", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", id: "t9", name: "f", input: {} }],
      }],
    }, true);
    const stub = out.messages.find((m) => m.role === "tool");
    expect(stub).toBeDefined();
    expect(stub.content).toBe("");
  });
});

describe("X36 thinking separator / redacted skip", () => {
  it("two thinking blocks stay delimited", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "first" },
          { type: "thinking", thinking: "second" },
        ],
      }],
    }, true);
    expect(out.messages[0].reasoning_content).toBe("first\nsecond");
  });
  it("redacted input yields no reasoning_content", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [{
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "ciphertext-blob" }],
      }],
    }, true);
    expect(JSON.stringify(out.messages)).not.toContain("ciphertext-blob");
    expect(out.messages[0]?.reasoning_content).toBeUndefined();
  });
});
