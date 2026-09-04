// Google Translate TTS (no auth) — scrape token + batchexecute RPC
import { UA } from "./_base.js";

const REFRESH_MS = 11 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const cache = { token: null, tokenTime: 0 };
let _idx = 0;

function timeoutSignal(signal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  if (signal && typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return signal?.aborted ? signal : timeout;
}

async function getToken(signal) {
  const now = Date.now();
  if (cache.token && now - cache.tokenTime < REFRESH_MS) return cache.token;
  const res = await fetch("https://translate.google.com/", { headers: { "User-Agent": UA }, signal: timeoutSignal(signal) });
  if (!res.ok) throw new Error(`Google translate fetch failed: ${res.status}`);
  const html = await res.text();
  const fSid = html.match(/"FdrFJe":"(.*?)"/)?.[1];
  const bl = html.match(/"cfb2h":"(.*?)"/)?.[1];
  if (!fSid || !bl) throw new Error("Failed to parse Google token");
  cache.token = { "f.sid": fSid, bl };
  cache.tokenTime = now;
  return cache.token;
}

const moduleDefault = {
  noAuth: true,
  async synthesize(text, model, _credentials, _responseFormat, opts = {}) {
    const signal = timeoutSignal(opts?.signal);
    const lang = model || "en";
    const token = await getToken(signal);
    const cleanText = text.replace(/[@^*()\\/\-_+=><"'\u201c\u201d\u3010\u3011]/g, " ").replaceAll(", ", ". ");
    const rpcId = "jQ1olc";
    const reqId = (++_idx * 100000) + Math.floor(1000 + Math.random() * 9000);
    const query = new URLSearchParams({
      rpcids: rpcId,
      "f.sid": token["f.sid"],
      bl: token.bl,
      hl: lang,
      "soc-app": 1, "soc-platform": 1, "soc-device": 1,
      _reqid: reqId,
      rt: "c",
    });
    const payload = [cleanText, lang, null, "undefined", [0]];
    const body = new URLSearchParams();
    body.append("f.req", JSON.stringify([[[rpcId, JSON.stringify(payload), null, "generic"]]]));
    const res = await fetch(`https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": "https://translate.google.com/" },
      body: body.toString(),
      signal,
    });
    if (!res.ok) throw new Error(`Google TTS failed: ${res.status}`);
    const data = await res.text();
    // Scraped RPC envelope — validate every level so a Google markup change
    // surfaces as "token/format changed", not a positional TypeError.
    const changed = new Error("Google TTS token/format changed: unexpected response shape");
    const rpcLines = data.split("\n");
    if (rpcLines.length < 4) throw changed;
    let split;
    try {
      split = JSON.parse(rpcLines[3]);
    } catch {
      throw changed;
    }
    const inner = split?.[0]?.[2];
    if (typeof inner !== "string") throw changed;
    let base64;
    try {
      base64 = JSON.parse(inner)?.[0];
    } catch {
      throw changed;
    }
    if (typeof base64 !== "string" || base64.length < 100) throw new Error("Google TTS returned empty audio");
    return { base64, format: "mp3" };
  },
};

export default moduleDefault;
