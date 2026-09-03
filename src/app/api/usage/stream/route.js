// @ts-check
import { statsEmitter, getActiveRequests } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null, sendPending: null };

  const stream = new ReadableStream({
    async start(controller) {
      // P1: lightweight push only — the client merges just activeRequests,
      // recentRequests, errorProvider and pending, so the full getUsageStats()
      // report (all-time daily blobs + whole history table + decrypted
      // connections) is never computed here. Both events share one function.
      const send = async () => {
        if (state.closed) return;
        try {
          const { activeRequests, recentRequests, errorProvider, pending } = await getActiveRequests();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ activeRequests, recentRequests, errorProvider, pending })}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };
      state.send = send;
      state.sendPending = send;

      await state.send();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.sendPending);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
