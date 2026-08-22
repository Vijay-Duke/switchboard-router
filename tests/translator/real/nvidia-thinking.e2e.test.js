// E2E: hit live local proxy → verify nvidia MiniMax M2.7 doesn't 400 on
// unsupported "thinking" param (nvidia NIM is OpenAI-compatible).
// Requires dev server running on NV_E2E_PORT + NV_E2E_KEY set to a reusable secret.
// RUN_E2E=1 npx vitest run --config tests/vitest.config.js tests/translator/real/nvidia-thinking.e2e.test.js
import { describe, it, expect } from "vitest";

const PORT = process.env.NV_E2E_PORT || "20127";
const BASE = `http://localhost:${PORT}`;
const MODELS = [
  "nvidia/minimaxai/minimax-m2.7",
  "nvidia/minimaxai/minimax-m3",
  "nvidia/z-ai/glm-5.2",
  "nvidia/deepseek-ai/deepseek-v4-pro",
  "nvidia/deepseek-ai/deepseek-v4-flash",
  "nvidia/moonshotai/kimi-k2.6",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
];
const RUN = process.env.RUN_E2E === "1";
const maybe = RUN ? describe : describe.skip;

async function drain(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

maybe("nvidia thinking e2e", () => {
  const apiKey = process.env.NV_E2E_KEY || "";

  it.each(MODELS)("%s with reasoning_effort -> no 'thinking' 400", async (model) => {
    if (!apiKey) return expect(true).toBe(true);
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 64,
        reasoning_effort: "low",
        messages: [{ role: "user", content: "Reply with the single word: hi" }],
      }),
    });
    const raw = await drain(res);
    expect(/Unsupported parameter.*thinking/i.test(raw), `${model} rejected 'thinking'`).toBe(false);
    expect(res.status, `${model} bad status ${res.status}`).toBeLessThan(400);
  }, 90000);
});
