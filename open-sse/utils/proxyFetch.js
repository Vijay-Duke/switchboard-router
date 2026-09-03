import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { wrapHeaders } from "../identity/wrap.js";
import { getProfile, CLAUDE_MESSAGES_HEADER_ORDER, CLAUDE_COUNT_TOKENS_HEADER_ORDER } from "../identity/catalog.js";
import { createClaudeCodeFetch } from "../identity/tls/claude-code.js";
import { CLAUDE_CODE_TLS_SPEC_REV } from "../identity/tls/claude-code-spec.js";

let _nodeFetch = globalThis.fetch;
const originalFetch = (...args) => _nodeFetch(...args);
const proxyDispatchers = new Map();
const _impitByProxy = new Map();
let _loadChromeFetch = loadChromeFetch;
let _loadClaudeCodeFetch = async () => createClaudeCodeFetch();
let _loadImpit = async () => (await import("impit")).Impit;
// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    if (DNS_CACHE.size >= MEMORY_CONFIG.dnsCacheMaxSize) {
      const now = Date.now();
      for (const [key, value] of DNS_CACHE) {
        if (value.expiry <= now) DNS_CACHE.delete(key);
      }
      while (DNS_CACHE.size >= MEMORY_CONFIG.dnsCacheMaxSize) {
        DNS_CACHE.delete(DNS_CACHE.keys().next().value);
      }
    }
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
export function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

export function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Egress proxy for a target: per-connection proxy wins, else env proxy.
 * Shared by proxyAwareFetch and the Codex WebSocket hop so both egress alike.
 */
export function resolveProxyUrl(targetUrl, proxyOptions) {
  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  return connectionProxyUrl || normalizeProxyUrl(getEnvProxyUrl(targetUrl));
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
export async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      const oldestKey = proxyDispatchers.keys().next().value;
      const oldest = proxyDispatchers.get(oldestKey);
      proxyDispatchers.delete(oldestKey);
      Promise.resolve(oldest?.close?.()).catch(() => {});
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(normalized, new ProxyAgent({ uri: normalized }));
  }
  const dispatcher = proxyDispatchers.get(normalized);
  // Refresh insertion order so eviction is true least-recently-used.
  proxyDispatchers.delete(normalized);
  proxyDispatchers.set(normalized, dispatcher);
  return dispatcher;
}

function applyIdentityWrap(url, options = {}) {
  const accept = options.headers?.Accept || options.headers?.accept || "";
  const stream = typeof accept === "string" && accept.includes("text/event-stream");
  const wrapped = wrapHeaders(options.headers || {}, {
    identity: options.identity,
    provider: options.provider,
    format: options.format,
    overlay: options.overlay,
    credentialId: options.credentialId,
    stream: options.stream ?? stream,
    retryCount: options.retryCount,
    snapshot: options.snapshot,
    requestPath: new URL(url).pathname,
  });
  return {
    ...options,
    headers: wrapped.headers,
    _identityTls: wrapped.tls,
    _identityAlpn: wrapped.alpn,
    _identityTlsSpecRev: wrapped.tlsSpecRev,
    _identityProfile: wrapped.profileId,
  };
}

function publicFetchInit(options) {
  const {
    _identityTls, _identityAlpn, _identityTlsSpecRev, _identityProfile,
    identity, provider, format, overlay, credentialId, stream, retryCount, snapshot,
    ...init
  } = options;
  return init;
}

async function loadChromeFetch(proxyUrl) {
  const key = proxyUrl || "";
  let client = _impitByProxy.get(key);
  if (!client) {
    const Impit = await _loadImpit();
    client = new Impit({ browser: "chrome", ...(proxyUrl ? { proxyUrl } : {}), followRedirects: false });
    _impitByProxy.set(key, client);
  }
  return (url, init) => client.fetch(url, init);
}

export function __setTransportLoadersForTests(loaders = {}) {
  if (loaders.nodeFetch) _nodeFetch = loaders.nodeFetch;
  if (loaders.loadChromeFetch) _loadChromeFetch = loaders.loadChromeFetch;
  if (loaders.loadClaudeCodeFetch) _loadClaudeCodeFetch = loaders.loadClaudeCodeFetch;
  if (loaders.loadImpit) _loadImpit = loaders.loadImpit;
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
export async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  const CONNECT_TIMEOUT_MS = 10_000;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let req;

    function cleanup() {
      socket.setTimeout(0);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      req?.destroy();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }

    if (options.signal?.aborted) { onAbort(); return; }
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error(`[ProxyFetch] connect timeout after ${CONNECT_TIMEOUT_MS}ms to ${realIP}`));
    });

    socket.connect(HTTPS_PORT, realIP, () => {
      socket.setTimeout(0);

      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      req = https.request(reqOptions, (res) => {
        const onBodyAbort = () => {
          try { res.destroy(new DOMException("The operation was aborted.", "AbortError")); } catch { res.destroy(); }
        };
        const cleanupBodyAbort = () => options.signal?.removeEventListener("abort", onBodyAbort);
        if (options.signal?.aborted) {
          settled = true;
          cleanup();
          onBodyAbort();
          cleanupBodyAbort();
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        options.signal?.addEventListener("abort", onBodyAbort, { once: true });
        res.once("end", cleanupBodyAbort);
        res.once("close", cleanupBodyAbort);
        res.once("error", cleanupBodyAbort);

        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        settled = true;
        cleanup();
        resolve(response);
      });

      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();
  const wrapped = applyIdentityWrap(targetUrl, options);
  const fetchInit = publicFetchInit(wrapped);
  const { _identityTls, _identityAlpn, _identityProfile } = wrapped;

  // Identity is applied before relaying. Relay-only headers exist only on this hop.
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    return originalFetch(vercelRelayUrl, {
      ...fetchInit,
      headers: {
        ...fetchInit.headers,
        "x-relay-target": `${parsed.protocol}//${parsed.host}`,
        "x-relay-path": `${parsed.pathname}${parsed.search}`,
      },
    });
  }

  const proxyUrl = resolveProxyUrl(targetUrl, proxyOptions);

  if (_identityTls !== "node") {
    try {
      const transport = {
        profileId: _identityProfile,
        alpn: _identityAlpn,
        proxyUrl,
        headerOrder: _identityProfile === "claude-cli"
          ? (new URL(targetUrl).pathname.startsWith("/v1/messages/count_tokens")
              ? CLAUDE_COUNT_TOKENS_HEADER_ORDER
              : CLAUDE_MESSAGES_HEADER_ORDER)
          : getProfile(_identityProfile)?.headerOrder || [],
      };
      const snapshotTlsVersion = /^claude-code-(\d+\.\d+\.\d+)$/.exec(wrapped._identityTlsSpecRev || "")?.[1]
        || wrapped._identityTlsSpecRev;
      if (_identityProfile === "claude-cli" && snapshotTlsVersion !== CLAUDE_CODE_TLS_SPEC_REV) {
        throw new Error(`snapshot TLS spec ${wrapped._identityTlsSpecRev || "missing"} does not match helper ${CLAUDE_CODE_TLS_SPEC_REV}`);
      }
      const transportFetch = _identityTls === "chrome"
        ? await _loadChromeFetch(proxyUrl)
        : await _loadClaudeCodeFetch();
      return await transportFetch(url, fetchInit, transport);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      const error = new Error(`[ProxyFetch] ${_identityTls} TLS (${_identityProfile}) unavailable: ${err.message}`);
      error.status = 503;
      throw error;
    }
  }

  // Existing Node/undici proxy, MITM bypass, and direct behavior remains unchanged.
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        return await originalFetch(url, { ...fetchInit, dispatcher });
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, fetchInit);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      const dispatcher = await getDispatcher(proxyUrl);
      return await originalFetch(url, { ...fetchInit, dispatcher });
    } catch (proxyError) {
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return originalFetch(url, fetchInit);
    }
  }

  return originalFetch(url, fetchInit);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
