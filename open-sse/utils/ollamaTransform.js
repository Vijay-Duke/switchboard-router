// Transform OpenAI SSE stream to Ollama JSON lines format
export function transformToOllama(response, model) {
  let buffer = "";
  let pendingToolCalls = {};
  // Single-terminal guard: exactly one done:true per stream no matter how many
  // terminal signals arrive (finish "stop" + "[DONE]" + flush).
  let ended = false;
  // One persistent decoder fed with { stream: true } so multibyte chars split
  // across TCP chunks don't decode to U+FFFD.
  const decoder = new TextDecoder();
  const encode = (obj) => new TextEncoder().encode(`${JSON.stringify(obj)}\n`);
  const doneLine = () => encode({ model, message: { role: "assistant", content: "" }, done: true });

  // Returns true when this line terminated the stream.
  const processLine = (line, controller) => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();

    if (data === "[DONE]") {
      ended = true;
      controller.enqueue(doneLine());
      return true;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return false; // Silently ignore parse errors
    }

    // Upstream SSE error events (with or without an empty choices[] alongside,
    // as executor-emitted mid-stream errors carry) surface as Ollama errors and
    // terminate instead of dropping into an empty done:true.
    if (parsed && typeof parsed === "object" && parsed.error) {
      const raw = parsed.error?.message ?? parsed.error;
      ended = true;
      controller.enqueue(encode({ error: typeof raw === "string" ? raw : JSON.stringify(raw) }));
      return true;
    }

    const delta = parsed.choices?.[0]?.delta || {};
    const content = delta.content || "";
    const toolCalls = delta.tool_calls;

    if (toolCalls) {
      for (const tc of toolCalls) {
        const idx = tc.index;
        if (!pendingToolCalls[idx]) {
          pendingToolCalls[idx] = { id: tc.id, function: { name: "", arguments: "" } };
        }
        if (tc.function?.name) pendingToolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) pendingToolCalls[idx].function.arguments += tc.function.arguments;
      }
    }

    if (content) {
      controller.enqueue(encode({ model, message: { role: "assistant", content }, done: false }));
    }

    const finishReason = parsed.choices?.[0]?.finish_reason;
    if (finishReason === "tool_calls" || finishReason === "stop") {
      const toolCallsArr = Object.values(pendingToolCalls);
      ended = true;
      if (toolCallsArr.length > 0) {
        const formattedCalls = toolCallsArr.map(tc => ({
          function: {
            name: tc.function.name,
            arguments: (() => { try { return JSON.parse(tc.function.arguments || "{}"); } catch { return {}; } })()
          }
        }));
        controller.enqueue(encode({
          model,
          message: { role: "assistant", content: "", tool_calls: formattedCalls },
          done: true
        }));
        pendingToolCalls = {};
      } else {
        controller.enqueue(doneLine());
      }
      return true;
    }
    return false;
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      if (ended) return;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (ended) break;
        processLine(line, controller);
      }
    },
    flush(controller) {
      try {
        buffer += decoder.decode();
      } catch {
        // ignore decoder flush errors — still terminate below
      }
      // A final line without a trailing newline would otherwise be dropped.
      if (!ended && buffer.trim()) {
        processLine(buffer, controller);
        buffer = "";
      }
      if (!ended) {
        ended = true;
        controller.enqueue(doneLine());
      }
    }
  });

  if (!response.body) {
    return new Response("", { status: response.status, headers: { "Content-Type": "application/x-ndjson" } });
  }
  // Preserve the upstream status (an upstream error must not become 200).
  return new Response(response.body.pipeThrough(transform), {
    status: response.status ?? 200,
    headers: { "Content-Type": "application/x-ndjson" }
  });
}
