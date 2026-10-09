import crypto from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { getProviderConnections } from "@/lib/db/index.js";

const owners = makeKv("claudeThreadOwners");
const MAX_OWNERS = 10000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
let nextCleanup = 0;
const ownerKey = (provider, clientKeyId, messageId) => crypto.createHash("sha256")
  .update(JSON.stringify([provider, clientKeyId || "local-no-key", messageId])).digest("hex");

const isCurrentPin = pin => !!pin && typeof pin.connectionId === "string" && typeof pin.model === "string"
  && Number.isFinite(pin.savedAt) && pin.savedAt <= Date.now() && Date.now() - pin.savedAt <= MAX_AGE_MS;

function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); fn(value); };
    const abort = () => finish(reject, new Error("Thread ownership operation aborted"));
    const timer = setTimeout(() => finish(reject, new Error("Thread ownership persistence timed out")), 2000);
    // The operation is already started: consume rejection even after abort.
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function sweep() {
  const signal = AbortSignal.timeout(2000);
  const entries = Object.entries(await bounded(owners.getAll(), signal)).sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0));
  for (let i = 0; i < entries.length; i++) {
    if (i >= MAX_OWNERS || !isCurrentPin(entries[i][1])) await bounded(owners.remove(entries[i][0]), signal);
  }
}

async function remember(messageId, { provider, model, clientKeyId, connectionId, signal }) {
  if (typeof messageId !== "string" || !messageId || !connectionId) return;
  await bounded(owners.set(ownerKey(provider, clientKeyId, messageId), { connectionId, model, savedAt: Date.now() }), signal);
  if (Date.now() < nextCleanup) return;
  nextCleanup = Date.now() + 60000;
  // Cleanup has its own deadline and never delays the response ID's delivery.
  void sweep().catch(() => {});
}

// Persist ownership independently of optional diagnostics and scheduler TTLs.
// Old/unrecorded threads are safe to try only when exactly one account exists.
export async function resolveClaudeThreadOwner({ body, provider, model, clientKeyId, signal }) {
  const key = ownerKey(provider, clientKeyId, body.thread.previous_message_id);
  const pin = await bounded(owners.get(key), signal);
  if (isCurrentPin(pin)) {
    if (pin.model !== model) return { error: "Claude thread belongs to a different model; send full history to change models." };
    return { connectionId: pin.connectionId };
  }
  if (pin) void bounded(owners.remove(key), signal).catch(() => {});
  const connections = await bounded(getProviderConnections({ provider, isActive: true }), signal);
  if (connections.length === 1) return { connectionId: connections[0].id };
  return { error: "Claude thread account is unknown; send full history to establish account ownership." };
}

// Observe only the response ID; forward each original byte without cloning or
// buffering an entire stream. Persist before exposing the ID to the client.
export function bindClaudeThreadResponse(response, context) {
  if (!response?.ok || !response.body || !context.connectionId) return response;
  const sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "", observed = false;
  const save = async id => {
    observed = true;
    try { await remember(id, context); }
    catch { context.log?.warn?.("THREAD", "Could not persist Claude thread account ownership."); }
  };
  const transform = new TransformStream({
    async transform(chunk, controller) {
      if (!observed) {
        buffer += decoder.decode(chunk, { stream: true });
        if (sse) {
          let end;
          while (!observed && (end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trimEnd(); buffer = buffer.slice(end + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const event = JSON.parse(line.slice(5));
              if (event.type === "message_start" && typeof event.message?.id === "string") await save(event.message.id);
            } catch { /* Non-message frames are opaque to this observer. */ }
          }
        }
        if (!sse && !observed) {
          // Native Claude JSON puts its message ID first. Parse only that
          // complete root value, never a nested/content string's fake ID.
          const match = /^\s*\{\s*"id"\s*:\s*("(?:\\.|[^"\\])*")\s*[,}]/.exec(buffer);
          if (match) {
            let id;
            try { id = JSON.parse(match[1]); } catch { observed = true; }
            if (typeof id === "string") await save(id);
          }
        }
        if (buffer.length > 65536) {
          if (!observed) context.log?.warn?.("THREAD", "Claude response exceeded the ownership observer bound before its message ID.");
          observed = true; buffer = "";
        }
      }
      controller.enqueue(chunk);
    },
    async flush() {
      if (!sse && !observed) {
        try { const message = JSON.parse(buffer + decoder.decode()); if (message.id) await save(message.id); }
        catch { /* Not a native Claude JSON response. */ }
      }
    },
  });
  return new Response(response.body.pipeThrough(transform), { status: response.status, statusText: response.statusText, headers: response.headers });
}
