// Codex OAuth transcription: ChatGPT's internal /backend-api/transcribe.
// Upstream-adapted from 9router 421f2262 (Codex OAuth STT), reworked for
// Switchboard's identity/proxy plumbing: the request egresses through
// proxyAwareFetch with the codex-cli identity, so the codex chat lane's
// User-Agent/originator headers, chrome TLS, connection proxies and the
// Vercel relay all apply to audio too. An OpenAI API key is never accepted —
// only stored Codex OAuth connections.
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import codex from "../providers/registry/codex.js";
import { convertAudio, readBounded, MAX_AUDIO_BYTES } from "./codexSttAudio.js";
import { createErrorResult } from "../utils/error.js";

// ffmpeg conversion is single-threaded and the endpoint is an internal,
// rate-limited ChatGPT API — cap the process at two in-flight jobs.
let active = 0;

const failure = (status, message) => Object.assign(new Error(message), { status });
const ALLOWED_FORM_FIELDS = ["model", "file", "response_format", "language", "prompt", "temperature"];

export async function transcribeCodex({ formData, credentials, abortSignal, proxyOptions }) {
  let slot = false;
  // Hard ceiling per attempt even when the caller never aborts.
  const signal = AbortSignal.any([...(abortSignal ? [abortSignal] : []), AbortSignal.timeout(60000)]);
  try {
    const account = credentials?.providerSpecificData || {};
    const accountId = account.workspaceId || account.chatgptAccountId || account.accountId;
    if (credentials?.authType !== "oauth" || typeof credentials.accessToken !== "string"
      || !/^[\x21-\x7e]+$/.test(credentials.accessToken)
      || typeof accountId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(accountId)) {
      throw failure(401, "A valid Codex OAuth account is required (an OpenAI API key is not accepted)");
    }
    for (const [key] of formData) {
      if (!ALLOWED_FORM_FIELDS.includes(key) || formData.getAll(key).length !== 1) throw failure(400, "Unsupported or duplicate form field");
    }
    const format = formData.get("response_format") || "json";
    if (!["json", "text"].includes(format)) throw failure(400, "Only json and text response formats are supported");
    for (const key of ["language", "prompt", "temperature"]) {
      if (formData.has(key) && formData.get(key) !== "") throw failure(400, `${key} is not supported by Codex transcription`);
    }
    const file = formData.get("file");
    if (!(file instanceof Blob) || !file.size) throw failure(400, "A non-empty audio file is required");
    if (file.size > MAX_AUDIO_BYTES) throw failure(413, "Audio exceeds 25 MiB");
    if (active >= 2) throw failure(503, "Transcription capacity reached");
    active++; slot = true;
    signal.throwIfAborted();
    const audio = await convertAudio(file, signal);
    // Hand-rolled file-only multipart: the endpoint accepts exactly one part
    // and nothing else — no model field, no options.
    const boundary = `----switchboard-codex-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      Buffer.from(await audio.arrayBuffer()), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await proxyAwareFetch(codex.sttConfig.baseUrl, {
      method: "POST",
      redirect: "error",
      signal,
      body,
      // Same egress as the codex chat lane: the identity layer supplies the
      // codex-cli UA/originator/version headers and chrome TLS on the direct
      // path; a configured connection proxy or relay still wins.
      identity: credentials?.runtimeTransport?.identity || codex.transport?.identity,
      provider: "codex",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "ChatGPT-Account-Id": accountId,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
    }, proxyOptions);
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      return createErrorResult(response.status >= 400 && response.status <= 599 ? response.status : 502, "Codex transcription failed");
    }
    const bytes = await readBounded(response.body, 1024 * 1024, signal, 502);
    let data;
    try { data = JSON.parse(bytes.toString("utf8")); } catch { throw failure(502, "Invalid transcription response"); }
    if (typeof data?.text !== "string" || data.text.length > 250000) throw failure(502, "Invalid transcription response");
    // Only {text} is ever returned — upstream metadata (account hints,
    // segments, timings) is deliberately not projected to callers.
    return { success: true, response: format === "text"
      ? new Response(data.text, { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } })
      : Response.json({ text: data.text }, { headers: { "Cache-Control": "no-store" } }) };
  } catch (error) {
    return createErrorResult(error.status || (signal.aborted ? 504 : 502), error.status ? error.message : "Codex transcription failed");
  } finally {
    if (slot) active--;
  }
}
