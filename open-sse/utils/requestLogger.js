// Check if running in Node.js environment (has fs module)
import {
  FULL_REDACTION_REQUEST_LOG_HEADER_NAMES,
  SENSITIVE_REQUEST_LOG_HEADER_NAMES,
} from "../config/appConstants.js";

const isNode = typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";

// Check if logging is enabled via environment variable (default: false)
const LOGGING_ENABLED = typeof process !== "undefined" && process.env?.ENABLE_REQUEST_LOGS === 'true';

let fs = null;
let path = null;
let LOGS_DIR = null;

// Lazy load Node.js modules (avoid top-level await)
async function ensureNodeModules() {
  if (!isNode || !LOGGING_ENABLED || fs) return;
  try {
    // Use the default export (the shared CJS exports object) so tests can
    // spy on fs methods; namespace named imports are snapshots and miss that.
    const fsMod = await import("fs");
    const pathMod = await import("path");
    fs = fsMod.default || fsMod;
    path = pathMod.default || pathMod;
    LOGS_DIR = path.join(typeof process !== "undefined" && process.cwd ? process.cwd() : ".", "logs");
  } catch {
    // Running in non-Node environment (Worker, Browser, etc.)
  }
}

// Format timestamp for folder name: 20251228_143045_123
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${h}${min}${s}_${ms}`;
}

// Create log session folder: {sourceFormat}_{targetFormat}_{model}_{timestamp}
async function createLogSession(sourceFormat, targetFormat, model) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return null;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const timestamp = formatTimestamp();
    const safeModel = (model || "unknown").replace(/[/:]/g, "-");
    const folderName = `${sourceFormat}_${targetFormat}_${safeModel}_${timestamp}`;
    const sessionPath = path.join(LOGS_DIR, folderName);
    
    fs.mkdirSync(sessionPath, { recursive: true });
    
    return sessionPath;
  } catch (err) {
    console.log("[LOG] Failed to create log session:", err.message);
    return null;
  }
}

const SESSION_IDENTIFIER_KEYS = new Set([
  "prompt_cache_key",
  "session_id",
  "sessionid",
  "conversation_id",
  "conversationid",
  "user_id",
  "userid",
  "request_id",
  "requestid",
  "x_session_id",
  "x_amp_thread_id",
  "x_client_request_id",
]);

export function redactSessionIdentifiers(value) {
  if (Array.isArray(value)) return value.map(redactSessionIdentifiers);
  if (!value || typeof value !== "object") return value;

  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    redacted[key] = SESSION_IDENTIFIER_KEYS.has(normalized)
      ? "[redacted]"
      : redactSessionIdentifiers(nested);
  }
  return redacted;
}

// Write JSON file
function writeJsonFile(sessionPath, filename, data) {
  if (!fs || !sessionPath) return;
  
  try {
    const filePath = path.join(sessionPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(redactSessionIdentifiers(data), null, 2));
  } catch (err) {
    console.log(`[LOG] Failed to write ${filename}:`, err.message);
  }
}

// Mask sensitive headers before writing request logs to disk (H6).
export function maskSensitiveHeaders(headers) {
  if (!headers) return {};
  const masked = { ...headers };

  for (const key of Object.keys(masked)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_REQUEST_LOG_HEADER_NAMES.some((name) => lowerKey.includes(name))) {
      const value = masked[key];
      if (FULL_REDACTION_REQUEST_LOG_HEADER_NAMES.some((name) => lowerKey.includes(name))) {
        masked[key] = "[redacted]";
      } else if (typeof value === "string" && value.length > 12) {
        masked[key] = value.slice(0, 8) + "..." + value.slice(-4);
      } else if (value != null) {
        masked[key] = "[redacted]";
      }
    }
  }
  return masked;
}

// No-op logger when logging is disabled
function createNoOpLogger() {
  return {
    sessionPath: null,
    logClientRawRequest() {},
    logRawRequest() {},
    logOpenAIRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    appendProviderChunk() {},
    appendOpenAIChunk() {},
    logConvertedResponse() {},
    appendConvertedChunk() {},
    logError() {},
    close() {}
  };
}

/**
 * Create a new log session and return logger functions
 * @param {string} sourceFormat - Source format from client (claude, openai, etc.)
 * @param {string} targetFormat - Target format to provider (antigravity, gemini-cli, etc.)
 * @param {string} model - Model name
 * @returns {Promise<object>} Promise that resolves to logger object with methods to log each stage
 */
export async function createRequestLogger(sourceFormat, targetFormat, model) {
  // Return no-op logger if logging is disabled
  if (!LOGGING_ENABLED) {
    return createNoOpLogger();
  }
  
  // Wait for session to be created before returning logger
  const sessionPath = await createLogSession(sourceFormat, targetFormat, model);

  // One append-mode WriteStream per chunk file, opened lazily. Previously each
  // append did open+write+close via appendFileSync on the event loop, up to
  // three times per streamed chunk. A WriteStream serializes writes (raw
  // fs.write calls to one fd can complete out of order on the threadpool) and
  // close() ends each stream, which releases the fd only after its queue
  // drains (a closeSync with writes in flight risks EBADF / fd reuse).
  let chunkStreams = {};
  let chunksClosed = false;
  function appendChunk(key, filename, chunk) {
    if (!fs || !sessionPath || chunksClosed) return;
    try {
      let ws = chunkStreams[key];
      if (!ws) {
        ws = chunkStreams[key] = fs.createWriteStream(path.join(sessionPath, filename), { flags: "a" });
        ws.on("error", () => { /* chunk debug logs must never break a stream */ });
      }
      ws.write(chunk);
    } catch {
      // Ignore write errors
    }
  }
  function closeChunkFiles() {
    chunksClosed = true;
    const streams = Object.values(chunkStreams);
    chunkStreams = {};
    return Promise.all(streams.map((ws) => new Promise((resolve) => {
      try { ws.end(resolve); } catch { resolve(); }
    })));
  }

  return {
    get sessionPath() { return sessionPath; },
    
    // 1. Log client raw request (before any conversion)
    logClientRawRequest(endpoint, body, headers = {}) {
      writeJsonFile(sessionPath, "1_req_client.json", {
        timestamp: new Date().toISOString(),
        endpoint,
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 2. Log raw request from client (after initial conversion like responsesApi)
    logRawRequest(body, headers = {}) {
      writeJsonFile(sessionPath, "2_req_source.json", {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 3. Log OpenAI intermediate format (source → openai)
    logOpenAIRequest(body) {
      writeJsonFile(sessionPath, "3_req_openai.json", {
        timestamp: new Date().toISOString(),
        body
      });
    },
    
    // 4. Log target format request (openai → target)
    logTargetRequest(url, headers, body) {
      writeJsonFile(sessionPath, "4_req_target.json", {
        timestamp: new Date().toISOString(),
        url,
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 5. Log provider response (for non-streaming or error)
    logProviderResponse(status, statusText, headers, body) {
      const filename = "5_res_provider.json";
      writeJsonFile(sessionPath, filename, {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: maskSensitiveHeaders(
          headers && typeof headers.entries === "function" ? Object.fromEntries(headers.entries()) : headers
        ),
        body
      });
    },
    
    // 5. Append streaming chunk to provider response
    appendProviderChunk(chunk) {
      appendChunk("provider", "5_res_provider.txt", chunk);
    },

    // 6. Append OpenAI intermediate chunks (target → openai)
    appendOpenAIChunk(chunk) {
      appendChunk("openai", "6_res_openai.txt", chunk);
    },
    
    // 7. Log converted response to client (for non-streaming)
    logConvertedResponse(body) {
      writeJsonFile(sessionPath, "7_res_client.json", {
        timestamp: new Date().toISOString(),
        body
      });
    },
    
    // 7. Append streaming chunk to converted response
    appendConvertedChunk(chunk) {
      appendChunk("converted", "7_res_client.txt", chunk);
    },

    // 6. Log error
    logError(error, requestBody = null) {
      writeJsonFile(sessionPath, "6_error.json", {
        timestamp: new Date().toISOString(),
        error: error?.message || String(error),
        requestBody
      });
    },

    // Release chunk-log files; called on stream flush/cancel and error paths.
    // Idempotent. Resolves once queued writes have drained (callers may ignore).
    close() {
      return closeChunkFiles();
    }
  };
}

// Legacy functions for backward compatibility
export function logRequest() {}
export function logResponse() {}
export function logError(provider, { error, url, model, requestBody }) {
  if (!fs || !LOGS_DIR) return;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(LOGS_DIR, `${provider}-${date}.log`);
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "error",
      provider,
      model,
      url,
      error: error?.message || String(error),
      stack: error?.stack,
      requestBody: redactSessionIdentifiers(requestBody),
    };
    
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    console.log("[LOG] Failed to write error log:", err.message);
  }
}
