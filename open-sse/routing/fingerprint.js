import { createHash } from "crypto";

/**
 * Lightweight request signals for router + learning (docs/switchboard/SPEC.md §7).
 * @param {object} body
 * @returns {{ fingerprint: string, modalities: string[], hasTools: boolean, toolCountBand: string, tokenBand: string, textLen: number, keywordHints: string[], userSummary: string }}
 */
export function buildRequestSignals(body) {
  const modalities = [];
  let hasVision = false;
  let hasPdf = false;
  let toolCount = 0;
  let textLen = 0;
  const texts = [];

  const scanBlock = (b) => {
    // Plain string content parts (OpenAI multi-part can include raw strings)
    if (typeof b === "string") {
      textLen += b.length;
      texts.push(b);
      return;
    }
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") hasVision = true;
    if (t === "file" || t === "document" || t === "input_file") hasPdf = true;
    // OpenAI chat: type "text"; Responses API: type "input_text" / "output_text"
    if (
      (t === "text" || t === "input_text" || t === "output_text") &&
      typeof b.text === "string"
    ) {
      textLen += b.text.length;
      texts.push(b.text);
    }
    // Some SDKs nest text under content
    if (typeof b.content === "string" && !t) {
      textLen += b.content.length;
      texts.push(b.content);
    }
  };

  const scanContent = (content) => {
    if (typeof content === "string") {
      textLen += content.length;
      texts.push(content);
      return;
    }
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  for (const m of body?.messages || []) {
    if (m?.role === "user" || m?.role === "tool") scanContent(m.content);
  }
  if (typeof body?.input === "string") {
    scanContent(body.input);
  } else if (Array.isArray(body?.input)) {
    for (const it of body.input) {
      if (it?.role === "user" || it?.type === "message") {
        // scanContent already walks arrays via scanBlock — do not double-count
        scanContent(it.content);
      }
      // Responses API: { type: "input_text", text: "..." } at top of input[]
      if (it?.type === "input_text" || it?.type === "text") scanBlock(it);
    }
  }

  if (Array.isArray(body?.tools)) toolCount = body.tools.length;
  if (Array.isArray(body?.functions)) toolCount = Math.max(toolCount, body.functions.length);

  if (hasVision) modalities.push("vision");
  if (hasPdf) modalities.push("pdf");
  if (!modalities.length) modalities.push("text");

  const hasTools = toolCount > 0;
  const toolCountBand = toolCount === 0 ? "0" : toolCount <= 3 ? "1-3" : toolCount <= 10 ? "4-10" : "10+";
  const tokenBand =
    textLen < 500 ? "0-500" : textLen < 2000 ? "500-2k" : textLen < 8000 ? "2k-8k" : "8k+";

  const blob = texts.slice(-3).join("\n").slice(0, 4000);
  const keywordHints = [];
  if (/\brefactor\b/i.test(blob)) keywordHints.push("refactor");
  if (/\b(debug|bug|error|stack)\b/i.test(blob)) keywordHints.push("debug");
  if (/\b(test|spec|unit test)\b/i.test(blob)) keywordHints.push("test");
  if (/\b(explain|what is|how does)\b/i.test(blob)) keywordHints.push("explain");

  const userSummary = compressSummary(blob);

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        hasVision,
        hasPdf,
        hasTools,
        toolCountBand,
        tokenBand,
        keywordHints,
      })
    )
    .digest("hex")
    .slice(0, 16);

  return {
    fingerprint,
    modalities,
    hasTools,
    toolCountBand,
    tokenBand,
    textLen,
    keywordHints,
    userSummary,
  };
}

function compressSummary(text) {
  if (!text) return "(empty)";
  // Strip control chars / fence-breakers so untrusted user text cannot escape USER_INTENT
  const cleaned = String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/<<<USER_INTENT|USER_INTENT>>>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 280) return cleaned;
  return `${cleaned.slice(0, 200)}…${cleaned.slice(-60)}`;
}
