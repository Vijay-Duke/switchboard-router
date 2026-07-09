// @ts-check
/**
 * Browser JSON fetch helper for TanStack Query queryFns / mutations.
 * @template T
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<T>}
 */
export async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    credentials: "same-origin",
  });
  /** @type {any} */
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `Request failed (${res.status})`;
    const err = new Error(typeof message === "string" ? message : "Request failed");
    // @ts-expect-error attach status for callers
    err.status = res.status;
    // @ts-expect-error attach body
    err.data = data;
    throw err;
  }
  return /** @type {T} */ (data);
}
