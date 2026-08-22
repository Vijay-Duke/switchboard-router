/**
 * QA-004 — POST /v1/api/chat (Ollama-compatible) must preserve assistant
 * content for non-streaming responses and stop masking JSON error bodies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn() }));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));

const { POST } = await import("../../src/app/api/v1/api/chat/route.js");

function ollamaRequest(body) {
  return new Request("http://localhost/v1/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function readLines(res) {
  const text = await new Response(res.body, { headers: res.headers }).text();
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

describe("Ollama /v1/api/chat non-streaming transform (QA-004)", () => {
  beforeEach(() => {
    mocks.handleChat.mockReset();
  });

  it("preserves assistant content from the upstream Ollama envelope", async () => {
    mocks.handleChat.mockResolvedValue(
      jsonResponse({
        model: "upstream-echo",
        created_at: "2026-08-22T00:00:00.000Z",
        message: { role: "assistant", content: "QA mock reply" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 3,
        eval_count: 5,
      }),
    );

    const res = await POST(
      ollamaRequest({
        model: "qa-openai/qa-chat",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.message.role).toBe("assistant");
    expect(body.message.content).toBe("QA mock reply");
    expect(body.done).toBe(true);
    expect(body.done_reason).toBe("stop");
    expect(body.eval_count).toBe(5);
    // Echoes the requested model name, matching the streaming path.
    expect(body.model).toBe("qa-openai/qa-chat");
  });

  it("converts an OpenAI chat.completion JSON body to an Ollama envelope", async () => {
    mocks.handleChat.mockResolvedValue(
      jsonResponse({
        id: "chatcmpl-fb-1",
        object: "chat.completion",
        created: 1770000000,
        model: "qa-openai/qa-chat",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Thanks — noted." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );

    const res = await POST(
      ollamaRequest({
        model: "qa-openai/qa-chat",
        stream: false,
        messages: [{ role: "user", content: "2" }],
      }),
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.message.content).toBe("Thanks — noted.");
    expect(body.done).toBe(true);
    expect(body.eval_count).toBe(2);
  });

  it("passes JSON error responses through with their status instead of a 200 empty message", async () => {
    mocks.handleChat.mockResolvedValue(
      jsonResponse(
        { error: { message: "rate limited", type: "rate_limit_error" } },
        { status: 429, headers: { "Retry-After": "17" } },
      ),
    );

    const res = await POST(
      ollamaRequest({
        model: "qa-openai/qa-chat",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    const body = JSON.parse(await res.text());
    expect(body.error.message).toBe("rate limited");
  });

  it("still streams SSE responses through the line transform (regression guard)", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"QA "}}]}',
      'data: {"choices":[{"delta":{"content":"mock reply"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    mocks.handleChat.mockResolvedValue(
      new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await POST(
      ollamaRequest({
        model: "qa-openai/qa-chat",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(200);
    const lines = await readLines(res);
    const content = lines.filter((l) => l.done === false).map((l) => l.message.content).join("");
    expect(content).toBe("QA mock reply");
    const last = lines[lines.length - 1];
    expect(last.done).toBe(true);
    expect(last.model).toBe("qa-openai/qa-chat");
  });
});
