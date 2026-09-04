const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DATA_DIR } = require("./paths");
const { LOG_BLACKLIST_URL_PARTS } = require("./config");

function time() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

const log = (msg) => console.log(`[${time()}] [MITM] ${msg}`);
const err = (msg) => console.error(`[${time()}] ❌ [MITM] ${msg}`);

const DUMP_DIR = path.join(DATA_DIR, "logs", "mitm");
if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });

// Clear all files inside DUMP_DIR (called on MITM server start to avoid unbounded growth)
function clearDumpDir() {
  try {
    if (!fs.existsSync(DUMP_DIR)) return;
    for (const f of fs.readdirSync(DUMP_DIR)) {
      try { fs.rmSync(path.join(DUMP_DIR, f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

const EMPTY_BODY_RE = /^\s*(\{\s*\}|\[\s*\]|null)?\s*$/;

// Header names whose values must never land on disk (case-insensitive).
const SENSITIVE_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "x-api-key", "api-key", "x-auth-token",
]);

// Body keys whose values must never land on disk (case-insensitive). Plain
// "key" is deliberately absent: it is a common data field in tool arguments.
const SENSITIVE_KEYS = new Set([
  "api-key", "apikey", "api_key", "token", "access-token",
  "access_token", "accesstoken", "refresh-token", "refresh_token",
  "refreshtoken", "secret", "password", "auth",
]);
// Query params: same set plus "?key=" (Gemini-style API keys in the URL).
const SENSITIVE_QUERY_KEYS = new Set([...SENSITIVE_KEYS, "key"]);

const REDACTED = "[REDACTED]";

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = SENSITIVE_HEADERS.has(String(name).toLowerCase()) ? REDACTED : value;
  }
  return out;
}

function redactUrl(url) {
  if (!url || !url.includes("?")) return url;
  const q = url.indexOf("?");
  const base = url.slice(0, q);
  const redacted = url.slice(q + 1).split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    try {
      if (SENSITIVE_QUERY_KEYS.has(decodeURIComponent(name).toLowerCase())) {
        return `${name}=${REDACTED}`;
      }
    } catch { /* malformed encoding — leave untouched */ }
    return pair;
  });
  return `${base}?${redacted.join("&")}`;
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEYS.has(String(k).toLowerCase()) ? REDACTED : redactValue(v),
      ])
    );
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, `Bearer ${REDACTED}`);
  }
  return value;
}

function redactBodyText(text) {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(redactValue(parsed));
  } catch {
    return redactValue(text);
  }
}

function slugify(s, max = 80) {
  return String(s).replace(/[^a-zA-Z0-9]/g, "_").substring(0, max);
}

function isBlacklisted(url) {
  if (!url) return false;
  return LOG_BLACKLIST_URL_PARTS.some(part => url.includes(part));
}

// Decode body buffer based on content-encoding header
function decodeBody(buf, encoding) {
  if (!buf || buf.length === 0) return buf;
  try {
    const enc = (encoding || "").toLowerCase();
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch { /* return raw on failure */ }
  return buf;
}

// Save redacted request: method + url + headers + body (secrets stripped)
function dumpRequest(req, bodyBuffer, tag = "raw") {
  if (isBlacklisted(req.url)) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = slugify((req.headers.host || "") + req.url);
    const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.req.json`);
    let parsed = null;
    try { parsed = JSON.parse(bodyBuffer.toString()); } catch { /* not JSON */ }
    fs.writeFileSync(file, JSON.stringify({
      method: req.method,
      url: redactUrl(req.url),
      host: req.headers.host,
      headers: redactHeaders(req.headers),
      body: parsed ? redactValue(parsed) : redactValue(bodyBuffer.toString("utf8"))
    }, null, 2));
    return file;
  } catch { return null; }
}

// Buffer-based response dumper — collects chunks then decodes + writes once on end()
// Trade-off: holds response in RAM, but enables gzip/br decoding for readable output.
function createResponseDumper(req, tag = "raw") {
  if (isBlacklisted(req.url)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = slugify((req.headers.host || "") + req.url);
  const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.res.txt`);
  let status = 0;
  let headers = {};
  const chunks = [];
  return {
    writeHeader: (s, h) => { status = s; headers = h || {}; },
    writeChunk: (chunk) => {
      if (chunk == null) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end: () => {
      try {
        const raw = Buffer.concat(chunks);
        const enc = headers["content-encoding"] || headers["Content-Encoding"];
        const decoded = decodeBody(raw, enc);
        const text = decoded.toString("utf8");
        // Skip empty / trivially-empty bodies
        if (EMPTY_BODY_RE.test(text)) return;
        // Strip content-encoding since body is now decoded
        const cleanHeaders = redactHeaders({ ...headers });
        delete cleanHeaders["content-encoding"];
        delete cleanHeaders["Content-Encoding"];
        const out = `STATUS: ${status}\nHEADERS: ${JSON.stringify(cleanHeaders, null, 2)}\n---BODY---\n${redactBodyText(text)}`;
        fs.writeFileSync(file, out);
      } catch { /* ignore */ }
    },
    file
  };
}

module.exports = { log, err, dumpRequest, createResponseDumper, clearDumpDir };
