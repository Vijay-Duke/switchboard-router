// @ts-check
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

function countValueChars(value) {
  const pending = [value];
  let total = 0;

  while (pending.length) {
    const current = pending.pop();
    if (current == null) continue;
    if (typeof current === "string") {
      total += current.length;
      continue;
    }
    if (typeof current === "number" || typeof current === "boolean") {
      total += String(current).length;
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        total += key.length;
        pending.push(item);
      }
    }
  }

  return total;
}

function countContentBlockChars(block) {
  if (block == null) return 0;
  if (typeof block === "string") return block.length;
  if (typeof block !== "object") return countValueChars(block);

  switch (block.type) {
    case "text":
      return countValueChars(block.text);
    case "tool_use":
      return countValueChars(block.name) + countValueChars(block.input);
    case "tool_result":
      return countValueChars(block.content);
    case "thinking":
      return countValueChars(block.thinking);
    default:
      return countValueChars(block);
  }
}

function countMessageChars(message) {
  if (!message || typeof message !== "object") return 0;
  const content = message.content;

  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, block) => total + countContentBlockChars(block), 0);
  }
  return countValueChars(content);
}

export function estimateAnthropicInputTokens(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let totalChars = countValueChars(body.system) + countValueChars(body.tools);

  for (const msg of messages) {
    totalChars += countMessageChars(msg);
  }

  return Math.ceil(totalChars / 4);
}

/**
 * POST /v1/messages/count_tokens - Mock token count response
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  const inputTokens = estimateAnthropicInputTokens(body);

  return new Response(JSON.stringify({
    input_tokens: inputTokens
  }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}
