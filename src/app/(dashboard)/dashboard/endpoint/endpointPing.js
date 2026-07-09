// @ts-check
// Local health ping helper for endpoint UI (optional client-side checks).

export async function clientPingUrl(url, { timeoutMs = 3000 } = {}) {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
      mode: "cors",
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function clientPingAny(...urls) {
  const targets = urls.flat().filter(Boolean);
  if (!targets.length) return false;
  const results = await Promise.all(targets.map((u) => clientPingUrl(u)));
  return results.some(Boolean);
}
