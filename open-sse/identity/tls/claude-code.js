import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Readable } from "node:stream";
import { CLAUDE_CODE_ALPN, CLAUDE_CODE_TLS_SPEC_REV } from "./claude-code-spec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const helperName = process.platform === "win32" ? "switchboard-claude-tls.exe" : "switchboard-claude-tls";
const candidates = [
  process.env.SWITCHBOARD_CLAUDE_TLS_HELPER,
  path.join(process.cwd(), "open-sse", "identity", "tls", "bin", process.platform, process.arch, helperName),
  path.join(here, "bin", process.platform, process.arch, helperName),
].filter(Boolean);

const DEFAULT_HELPER_TIMEOUT_MS = 60_000;
const MAX_HELPER_STDERR_BYTES = 16 * 1024;

function positiveTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : null;
}

function helperTimeout(init, transport) {
  return positiveTimeout(init.timeoutMs) ?? positiveTimeout(transport.timeoutMs) ?? DEFAULT_HELPER_TIMEOUT_MS;
}

let resolvedBinary;
let spawnChild = spawn;

// Stage 1 pre-spawn pool: hides the fork/exec cost of the one-shot TLS
// helper. Holds spawned-but-unused children: the helper blocks on its first
// stdin frame with no timeout, does no work before it, and takes proxyUrl
// from the frame, so any idle child can serve any request. Used children
// are never returned: the helper exits after one request. Idle children
// die after 60 s, or on stdin EOF when this process exits.
// SWITCHBOARD_CLAUDE_TLS_POOL_CAP: idle children kept warm (default 2,
// 0 disables the pool).
const CLAUDE_CODE_HELPER_POOL_CAP = poolCap(process.env.SWITCHBOARD_CLAUDE_TLS_POOL_CAP);
const CLAUDE_CODE_HELPER_IDLE_TTL_MS = 60_000;
const idle = new Map(); // child -> release()
let poolRefillHandle = null;

function poolCap(value) {
  if (value == null || value === "") return 2;
  const cap = Number(value);
  return Number.isInteger(cap) && cap >= 0 ? cap : 2;
}

function spawnHelperChild(binary) {
  return spawnChild(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

// ChildProcess.unref() alone does not release the event loop: the piped
// stdio sockets hold it too, so idle children unref all four handles.
function setHelperRef(child, ref) {
  for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
    handle?.[ref ? "ref" : "unref"]?.();
  }
}

function isHelperAlive(child) {
  return child.exitCode == null && child.signalCode == null;
}

function poolHelperChild(child) {
  const release = () => {
    clearTimeout(timer);
    child.off("exit", release);
    child.off("error", release);
    idle.delete(child);
  };
  const timer = setTimeout(() => {
    release();
    try { child.kill("SIGTERM"); } catch {}
  }, CLAUDE_CODE_HELPER_IDLE_TTL_MS);
  timer.unref?.();
  // A child that exits or errors (e.g. exec failure) while idle leaves the
  // pool immediately; the listener also keeps 'error' from going uncaught.
  child.once("exit", release);
  child.once("error", release);
  setHelperRef(child, false);
  idle.set(child, release);
}

function takePooledHelper() {
  for (const [child, release] of idle) {
    release();
    if (!isHelperAlive(child)) continue;
    setHelperRef(child, true);
    return child;
  }
  return null;
}

function refillHelperPool(binary) {
  while (idle.size < CLAUDE_CODE_HELPER_POOL_CAP) {
    let child;
    try { child = spawnHelperChild(binary); } catch { return; }
    poolHelperChild(child);
  }
}

// One coalesced refill per loop turn: a burst of N fetches spawns N serving
// children plus at most `cap` idle ones, never N replacements.
function schedulePoolRefill(binary) {
  if (poolRefillHandle || idle.size >= CLAUDE_CODE_HELPER_POOL_CAP) return;
  poolRefillHandle = setImmediate(() => {
    poolRefillHandle = null;
    refillHelperPool(binary);
  });
  poolRefillHandle.unref?.();
}

export function __drainClaudeCodeHelperPoolForTests() {
  if (poolRefillHandle) {
    clearImmediate(poolRefillHandle);
    poolRefillHandle = null;
  }
  for (const [child, release] of idle) {
    release();
    try { child.kill("SIGTERM"); } catch {}
  }
}

export function __setClaudeCodeSpawnForTest(replacement) {
  __drainClaudeCodeHelperPoolForTests();
  spawnChild = replacement || spawn;
}

async function resolveBinary() {
  if (resolvedBinary) return resolvedBinary;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      resolvedBinary = candidate;
      return candidate;
    } catch {}
  }
  throw new Error(`Claude Code TLS helper is not installed for ${process.platform}-${process.arch}`);
}

function headerEntries(headers) {
  if (headers instanceof Headers) return [...headers.entries()];
  return Object.entries(headers || {}).map(([name, value]) => [name, String(value)]);
}

function bodyToInput(body) {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError("Claude Code TLS helper requires a string or byte request body");
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function parseHelperResponse(stdout, stderr, child, signal) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let stderrText = "";
    let settled = false;
    const onStderr = (chunk) => {
      if (stderrText.length >= MAX_HELPER_STDERR_BYTES) return;
      stderrText += chunk.toString("utf8", 0, MAX_HELPER_STDERR_BYTES - stderrText.length);
    };
    const exitError = (code, exitSignal, phase) => {
      const detail = stderrText.trim();
      const exit = `${code == null ? "" : ` with code ${code}`}${exitSignal ? ` (${exitSignal})` : ""}`;
      return new Error(detail || `Claude TLS helper exited${phase}${exit}`);
    };
    const cleanupMetadata = () => {
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExitBeforeMetadata);
    };
    const cleanupAll = () => {
      cleanupMetadata();
      stderr.off("data", onStderr);
      signal?.removeEventListener("abort", onAbortBeforeMetadata);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanupAll();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onExitBeforeMetadata = (code, exitSignal) => fail(exitError(code, exitSignal, " before metadata"));
    const onAbortBeforeMetadata = () => {
      fail(abortError());
      child.kill("SIGTERM");
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      let meta;
      try { meta = JSON.parse(buffered.subarray(0, end).toString("utf8")); }
      catch (error) { fail(new Error(`Claude TLS helper returned invalid metadata: ${error.message}`)); return; }
      if (meta.error) { fail(new Error(meta.error)); return; }

      settled = true;
      cleanupMetadata();
      signal?.removeEventListener("abort", onAbortBeforeMetadata);

      const bodyStream = new PassThrough();
      const body = Readable.toWeb(bodyStream);
      let stdoutEnded = false;
      let childExited = false;
      let bodySettled = false;
      const cleanupBody = () => {
        stdout.unpipe(bodyStream);
        stdout.off("end", onStdoutEnd);
        stdout.off("error", onBodyError);
        stderr.off("data", onStderr);
        child.off("error", onBodyError);
        child.off("exit", onExitAfterMetadata);
        signal?.removeEventListener("abort", onAbortBody);
      };
      const finishBody = (error) => {
        if (bodySettled) return;
        bodySettled = true;
        cleanupBody();
        if (error) bodyStream.destroy(error);
        else bodyStream.end();
      };
      const destroyBody = (error) => {
        if (!stdout.destroyed) {
          stdout.once("error", () => {});
          stdout.destroy(error);
        }
        finishBody(error);
      };
      const onBodyError = (error) => finishBody(error);
      const onStdoutEnd = () => {
        stdoutEnded = true;
        if (childExited) finishBody();
      };
      const onExitAfterMetadata = (code, exitSignal) => {
        if (code !== 0 || exitSignal) {
          destroyBody(exitError(code, exitSignal, " after metadata"));
          return;
        }
        childExited = true;
        if (stdoutEnded) finishBody();
      };
      const onAbortBody = () => {
        const error = abortError();
        destroyBody(error);
        child.kill("SIGTERM");
      };
      stdout.once("end", onStdoutEnd);
      stdout.once("error", onBodyError);
      child.once("error", onBodyError);
      child.once("exit", onExitAfterMetadata);
      signal?.addEventListener("abort", onAbortBody, { once: true });
      bodyStream.write(buffered.subarray(end + 1));
      stdout.pipe(bodyStream, { end: false });
      resolve(new Response(body, {
        status: meta.status,
        statusText: meta.statusText || "",
        headers: new Headers(meta.headers || []),
      }));
    };
    stderr.on("data", onStderr);
    stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExitBeforeMetadata);
    signal?.addEventListener("abort", onAbortBeforeMetadata, { once: true });
    if (signal?.aborted) onAbortBeforeMetadata();
  });
}

export function createClaudeCodeFetch() {
  return async function claudeCodeFetch(url, init = {}, transport = {}) {
    if (transport.alpn?.length !== 1 || transport.alpn[0] !== "http/1.1") {
      throw new Error("Claude Code TLS transport requires ALPN http/1.1 only");
    }
    if (init.signal?.aborted) throw abortError();
    const binary = await resolveBinary();
    const child = takePooledHelper() ?? spawnHelperChild(binary);
    schedulePoolRefill(binary);

    const body = bodyToInput(init.body);
    const request = {
      url: String(url),
      method: init.method || "GET",
      headers: headerEntries(init.headers),
      headerOrder: transport.headerOrder || [],
      proxyUrl: transport.proxyUrl || "",
      tlsSpecRev: CLAUDE_CODE_TLS_SPEC_REV,
      alpn: CLAUDE_CODE_ALPN,
      bodyLength: body?.byteLength || 0,
      timeoutMs: helperTimeout(init, transport),
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    if (body) child.stdin.write(body);
    child.stdin.end();
    return parseHelperResponse(child.stdout, child.stderr, child, init.signal);
  };
}
