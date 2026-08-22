import { authenticateApiKey, getClientKeySpend } from "@/lib/db/index.js";
import { isLocalRequest } from "@/dashboardGuard";
import { hasValidCliToken } from "@/shared/utils/cliToken.js";

const WINDOW_MS = 60_000;

if (!global._clientKeyPolicyState) global._clientKeyPolicyState = { byId: new Map() };

function state() {
  return global._clientKeyPolicyState;
}

function allowed(target, clientKey) {
  if (!target) return true;
  const models = clientKey.allowedModels || [];
  const combos = clientKey.allowedCombos || [];
  if (models.length === 0 && combos.length === 0) return true;
  return target.kind === "combo"
    ? combos.includes(target.id)
    : models.includes(target.id);
}

function rejection(status, code, retryAfter = null) {
  const headers = { "content-type": "application/json" };
  if (retryAfter != null) headers["retry-after"] = String(retryAfter);
  return {
    ok: false,
    response: new Response(JSON.stringify({
      error: {
        message: "API key policy rejected this request",
        type: "client_key_policy_error",
        code,
      },
    }), { status, headers }),
  };
}

function bypass(mode) {
  return { ok: true, mode, clientKey: null, clientKeyId: null, lease: null };
}

export async function authorizeClientKeyRequest({ settings, rawKey, request, target }) {
  if (request && isLocalRequest(request)) return bypass("local");
  if (request) {
    try {
      if (await hasValidCliToken(request)) return bypass("cli");
    } catch {
      // CLI-token lookup failure falls through to ordinary gateway authentication.
    }
  }

  if (!rawKey) {
    return settings?.requireApiKey
      ? rejection(401, "missing_api_key")
      : bypass("local");
  }

  const clientKey = await authenticateApiKey(rawKey);
  if (!clientKey) {
    return settings?.requireApiKey
      ? rejection(401, "invalid_api_key")
      : bypass("local");
  }

  const now = Date.now();
  if (clientKey.expiresAt && new Date(clientKey.expiresAt).getTime() <= now) {
    return rejection(403, "client_key_expired");
  }
  if (!allowed(target, clientKey)) {
    return rejection(403, "client_key_target_not_allowed");
  }

  if (clientKey.spendLimitUsd != null) {
    const spentUsd = await getClientKeySpend(clientKey.id);
    clientKey.spentUsd = spentUsd;
    if (spentUsd >= clientKey.spendLimitUsd) {
      return rejection(429, "client_key_spend_limit_exceeded");
    }
  }

  let entry = state().byId.get(clientKey.id);
  if (!entry || now - entry.windowStartedAt >= WINDOW_MS) {
    entry = { windowStartedAt: now, acceptedStarts: 0, inFlight: entry?.inFlight || 0 };
    state().byId.set(clientKey.id, entry);
  }

  if (clientKey.concurrencyLimit != null && entry.inFlight >= clientKey.concurrencyLimit) {
    return rejection(429, "client_key_concurrency_limit_exceeded", 1);
  }
  if (clientKey.rateLimitPerMinute != null && entry.acceptedStarts >= clientKey.rateLimitPerMinute) {
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - entry.windowStartedAt)) / 1000));
    return rejection(429, "client_key_rate_limit_exceeded", retryAfter);
  }

  entry.acceptedStarts++;
  entry.inFlight++;
  let released = false;
  const lease = {
    release() {
      if (released) return;
      released = true;
      const current = state().byId.get(clientKey.id);
      if (current) current.inFlight = Math.max(0, current.inFlight - 1);
    },
  };

  return {
    ok: true,
    mode: "api-key",
    clientKey,
    clientKeyId: clientKey.id,
    lease,
  };
}

export async function runWithClientKeyLease(lease, work) {
  if (!lease) return await work();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };

  let response;
  try {
    response = await work();
  } catch (error) {
    release();
    throw error;
  }

  const isSse = response instanceof Response
    && response.body
    && (response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
  if (!isSse) {
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
      release();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function __resetClientKeyPolicyStateForTests() {
  global._clientKeyPolicyState = { byId: new Map() };
}
