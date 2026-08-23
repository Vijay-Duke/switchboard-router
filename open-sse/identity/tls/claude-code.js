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

export function __setClaudeCodeSpawnForTest(replacement) {
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
    const child = spawnChild(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

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
