import { trackPendingRequest } from "@/lib/db/repos/usageRepo.js";

function wrapResponse(response, release) {
  if (!(response instanceof Response) || !response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Count one selected connection while provider work is live. Non-Response
 * results finish immediately; streamed Responses finish on EOF, error, or
 * client cancellation.
 */
export async function withConnectionInFlight(
  { provider, model, connectionId },
  work,
) {
  if (!connectionId || connectionId === "noauth") return work();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    trackPendingRequest(model, provider, connectionId, false);
  };

  trackPendingRequest(model, provider, connectionId, true);
  try {
    const result = await work();
    if (result instanceof Response) return wrapResponse(result, release);
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}
