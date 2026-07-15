import { describe, it, expect } from "vitest";

import { deepseekAdapter } from "../../open-sse/utils/nativeToolCallAdapters/deepseek.js";
import {
  extractNativeToolCalls,
  getAdapterForModel,
  registerAdapter,
} from "../../open-sse/utils/nativeToolCallAdapters/index.js";
import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { encodeField, wrapConnectRPCFrame } from "../../open-sse/utils/cursorProtobuf.js";

// ─── Helper: build a Cursor protobuf response frame with text ────────────────
const LEN = 2;
function cursorResponseFrame({ text = "", thinking = "" }) {
  const responseFields = [];
  if (text) {
    responseFields.push(encodeField(1, LEN, text));
  }
  if (thinking) {
    const thinkingMessage = encodeField(1, LEN, thinking);
    responseFields.push(encodeField(25, LEN, thinkingMessage));
  }
  const response = Buffer.concat(responseFields.map((f) => Buffer.from(f)));
  const envelope = encodeField(2, LEN, response);
  return Buffer.from(wrapConnectRPCFrame(envelope));
}

// ─── DeepSeek Adapter: Detection ─────────────────────────────────────────────

describe("DeepSeek Adapter - detect()", () => {
  it("detects legacy format tokens", () => {
    const text = `Yes. Quick check:\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{"command":"pwd"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    expect(deepseekAdapter.detect(text)).toBe(true);
  });

  it("detects DSML format tokens", () => {
    const text = `Here is the result:\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">pwd\n</｜DSML｜invoke>`;
    expect(deepseekAdapter.detect(text)).toBe(true);
  });

  it("returns false for regular content without tool tokens", () => {
    expect(deepseekAdapter.detect("Hello world! Here is some code: ```json\n{}```")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(deepseekAdapter.detect("")).toBe(false);
  });
});

// ─── DeepSeek Adapter: Legacy Format Parsing ─────────────────────────────────

describe("DeepSeek Adapter - parse() legacy format", () => {
  it("parses single tool call with JSON arguments", () => {
    const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{"command":"pwd && echo tools OK"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].type).toBe("function");
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
      command: "pwd && echo tools OK",
    });
    expect(result.content).toBeNull();
  });

  it("preserves text content before tool calls", () => {
    const text = `Yes. Quick check:\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{"command":"pwd"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.content).toBe("Yes. Quick check:");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
  });

  it("parses multiple tool calls", () => {
    const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n\`\`\`json\n{"path":"src/main.js"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>list_dir\n\`\`\`json\n{"path":"src"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    expect(result.toolCalls[1].function.name).toBe("list_dir");
    // Each gets a unique ID
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
  });

  it("handles complex nested JSON arguments", () => {
    const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write_file\n\`\`\`json\n{"path":"test.json","content":"{\\"key\\": [1, 2, 3]}"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    expect(args.path).toBe("test.json");
  });

  it("handles missing end marker gracefully", () => {
    // Stream may be cut off
    const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{"command":"ls"}\n\`\`\`<｜tool▁call▁end｜>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
  });

  it("wraps invalid JSON in _raw field", () => {
    const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\nnot valid json at all\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    expect(args._raw).toBe("not valid json at all");
  });
});

// ─── DeepSeek Adapter: DSML Format Parsing ───────────────────────────────────

describe("DeepSeek Adapter - parse() DSML format", () => {
  it("parses DSML tool call with string parameter", () => {
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">pwd && echo OK\n</｜DSML｜invoke>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    expect(args.command).toBe("pwd && echo OK");
  });

  it("parses DSML tool call with non-string (JSON) parameter", () => {
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="count_items">\n<｜DSML｜parameter name="limit" string="false">10\n</｜DSML｜invoke>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    expect(args.limit).toBe(10);
  });

  it("parses DSML with mixed parameter types", () => {
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="search">\n<｜DSML｜parameter name="query" string="true">hello world\n<｜DSML｜parameter name="limit" string="false">5\n<｜DSML｜parameter name="case_sensitive" string="false">false\n</｜DSML｜invoke>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    expect(args.query).toBe("hello world");
    expect(args.limit).toBe(5);
    expect(args.case_sensitive).toBe(false);
  });

  it("preserves text content before DSML tool calls", () => {
    const text = `I'll search for that.\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="search">\n<｜DSML｜parameter name="query" string="true">test\n</｜DSML｜invoke>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.content).toBe("I'll search for that.");
  });

  it("parses multiple DSML invoke blocks", () => {
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">/src/a.js\n</｜DSML｜invoke>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">/src/b.js\n</｜DSML｜invoke>`;
    const result = deepseekAdapter.parse(text);

    expect(result).not.toBeNull();
    expect(result.toolCalls).toHaveLength(2);
    expect(JSON.parse(result.toolCalls[0].function.arguments).path).toBe("/src/a.js");
    expect(JSON.parse(result.toolCalls[1].function.arguments).path).toBe("/src/b.js");
  });
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe("Native Tool Call Adapter Registry", () => {
  it("resolves adapter for DeepSeek model names", () => {
    expect(getAdapterForModel("deepseek-chat")).toBe(deepseekAdapter);
    expect(getAdapterForModel("deepseek-v4-flash")).toBe(deepseekAdapter);
    expect(getAdapterForModel("deepseek-r1")).toBe(deepseekAdapter);
  });

  it("resolves adapter for Composer model names", () => {
    expect(getAdapterForModel("cu/composer-2.5")).toBe(deepseekAdapter);
    expect(getAdapterForModel("composer-2")).toBe(deepseekAdapter);
  });

  it("returns null for non-matching models", () => {
    expect(getAdapterForModel("gpt-4o")).toBeNull();
    expect(getAdapterForModel("claude-4.5-sonnet")).toBeNull();
    expect(getAdapterForModel("gemini-2.5-pro")).toBeNull();
  });

  it("returns null for null/empty model", () => {
    expect(getAdapterForModel(null)).toBeNull();
    expect(getAdapterForModel("")).toBeNull();
  });

  it("extractNativeToolCalls returns null when no adapter matches", () => {
    const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    expect(extractNativeToolCalls(text, "gpt-4o")).toBeNull();
  });

  it("extractNativeToolCalls returns null when no native tokens present", () => {
    expect(extractNativeToolCalls("Hello world", "cu/composer-2.5")).toBeNull();
  });

  it("extractNativeToolCalls works end-to-end", () => {
    const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{"command":"pwd"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const result = extractNativeToolCalls(text, "cu/composer-2.5");

    expect(result).not.toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
  });

  it("registerAdapter allows adding custom adapters", () => {
    const customAdapter = {
      name: "test",
      detect: (text) => text.includes("[[TOOL:"),
      parse: (text) => ({
        content: null,
        toolCalls: [{ id: "test_1", type: "function", function: { name: "test", arguments: "{}" } }],
      }),
    };

    registerAdapter(/my-custom-model/i, customAdapter);
    expect(getAdapterForModel("my-custom-model-v1")).toBe(customAdapter);
  });

  it("registerAdapter with prepend gives higher priority", () => {
    const overrideAdapter = {
      name: "override",
      detect: () => true,
      parse: () => ({ content: null, toolCalls: [] }),
    };

    // This should match before the default deepseek adapter
    registerAdapter(/deepseek-override/i, overrideAdapter, { prepend: true });
    expect(getAdapterForModel("deepseek-override")).toBe(overrideAdapter);
  });

  it("registerAdapter throws on invalid adapter", () => {
    expect(() => registerAdapter(/test/, null)).toThrow();
    expect(() => registerAdapter(/test/, {})).toThrow();
    expect(() => registerAdapter(/test/, { detect: () => true })).toThrow();
  });
});

// ─── CursorExecutor Integration ──────────────────────────────────────────────

describe("CursorExecutor + Native Tool Call Adapter (JSON)", () => {
  it("extracts native tool calls from text content in JSON mode", async () => {
    const text = `Yes. Quick check:\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{"command":"pwd && echo tools OK"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const buffer = cursorResponseFrame({ text });
    const executor = new CursorExecutor();

    const response = executor.transformProtobufToJSON(buffer, "cu/composer-2.5", {});
    const body = await response.json();

    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("bash");
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      command: "pwd && echo tools OK",
    });
    expect(body.choices[0].message.content).toBe("Yes. Quick check:");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });

  it("preserves normal responses for non-DeepSeek models", async () => {
    const text = "Hello, I'm Claude!";
    const buffer = cursorResponseFrame({ text });
    const executor = new CursorExecutor();

    const response = executor.transformProtobufToJSON(buffer, "cu/claude-4.5-sonnet", {});
    const body = await response.json();

    expect(body.choices[0].message.content).toBe("Hello, I'm Claude!");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  it("does not apply adapter when model does not match", async () => {
    const text = `Some content with <｜tool▁calls▁begin｜> fake tokens <｜tool▁calls▁end｜>`;
    const buffer = cursorResponseFrame({ text });
    const executor = new CursorExecutor();

    // With a non-matching model, it shouldn't extract
    const response = executor.transformProtobufToJSON(buffer, "cu/gpt-4o", {});
    const body = await response.json();

    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].message.content).toContain("fake tokens");
  });

  it("handles empty content after native tool extraction", async () => {
    const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{"command":"ls"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const buffer = cursorResponseFrame({ text });
    const executor = new CursorExecutor();

    const response = executor.transformProtobufToJSON(buffer, "cu/composer-2.5", {});
    const body = await response.json();

    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("CursorExecutor + Native Tool Call Adapter (SSE)", () => {
  function parseSSE(text) {
    return text
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => chunk.slice("data: ".length))
      .filter((data) => data !== "[DONE]")
      .map((data) => JSON.parse(data));
  }

  it("extracts native tool calls from text content in SSE mode", async () => {
    const text = `Yes. Quick check:\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n\`\`\`json\n{"command":"pwd"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const buffer = cursorResponseFrame({ text });
    const executor = new CursorExecutor();

    const response = executor.transformProtobufToSSE(buffer, "cu/composer-2.5", {});
    const chunks = parseSSE(await response.text());

    // Should have: role+content chunk, tool_call chunk, finish chunk
    const toolCallChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    const contentChunks = chunks.filter(
      (c) => c.choices?.[0]?.delta?.content !== undefined && c.choices?.[0]?.delta?.content !== ""
    );
    const finishChunks = chunks.filter((c) => c.choices?.[0]?.finish_reason);

    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0].choices[0].delta.tool_calls[0].function.name).toBe("bash");
    expect(contentChunks[0].choices[0].delta.content).toBe("Yes. Quick check:");
    expect(finishChunks[0].choices[0].finish_reason).toBe("tool_calls");
  });

  it("preserves normal SSE responses for non-matching models", async () => {
    const text = "Hello from Claude";
    const buffer = cursorResponseFrame({ text });
    const executor = new CursorExecutor();

    const response = executor.transformProtobufToSSE(buffer, "cu/claude-4.5-sonnet", {});
    const chunks = parseSSE(await response.text());

    const toolCallChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks).toHaveLength(0);

    const contentChunks = chunks.filter((c) => c.choices?.[0]?.delta?.content);
    expect(contentChunks[0].choices[0].delta.content).toBe("Hello from Claude");
  });
});
