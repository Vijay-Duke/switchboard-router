// @ts-check

function textFrom(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  return String(input.error || input.message || input.failureMessage || "");
}

function statusFrom(input, message) {
  const direct = Number(input?.status || input?.statusCode || input?.httpStatus);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = String(message || "").match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

/**
 * @param {any} input
 * @returns {{ status: "ok"|"dead"|"retryable", failureClass: "not_found"|"access_denied"|"timeout"|"throttled"|"server_error"|"auth"|"unknown"|null }}
 */
export function classifyFailure(input) {
  if (input?.ok === true) return { status: "ok", failureClass: null };

  const message = textFrom(input);
  const lower = message.toLowerCase();
  const httpStatus = statusFrom(input, message);
  const name = String(input?.name || "").toLowerCase();

  if (
    name.includes("abort") ||
    name.includes("timeout") ||
    lower.includes("abortsignal.timeout") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout")
  ) {
    return { status: "retryable", failureClass: "timeout" };
  }

  if (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("socket hang up")
  ) {
    return { status: "retryable", failureClass: "unknown" };
  }

  if (httpStatus === 401) return { status: "retryable", failureClass: "auth" };
  if (httpStatus === 429) return { status: "retryable", failureClass: "throttled" };
  if (httpStatus >= 500) return { status: "retryable", failureClass: "server_error" };

  if (
    httpStatus === 404 ||
    lower.includes("model not found") ||
    lower.includes("no such model") ||
    lower.includes("unknown model") ||
    lower.includes("does not exist") ||
    lower.includes("not a valid model") ||
    lower.includes("invalid model")
  ) {
    return { status: "dead", failureClass: "not_found" };
  }

  if (
    httpStatus === 403 ||
    lower.includes("access denied") ||
    lower.includes("permission denied") ||
    lower.includes("forbidden") ||
    lower.includes("not permitted") ||
    lower.includes("not authorized for model")
  ) {
    return { status: "dead", failureClass: "access_denied" };
  }

  return { status: "retryable", failureClass: "unknown" };
}
