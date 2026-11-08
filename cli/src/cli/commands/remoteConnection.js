const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getDataDir } = require("../../shared/dataDir");

function normalizeServerUrl(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) throw new Error("Server URL must use HTTP(S)");
  const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Server URL must use HTTP(S) without embedded credentials");
  return url.origin;
}
const sessionPath = () => path.join(getDataDir(), "connect-session.json");
function loadSession(server) {
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath(), "utf8"));
    return data.server === server && /^switchboard_session=[^;\r\n]+$/.test(data.cookie) ? data.cookie : null;
  } catch { return null; }
}
function saveSession(server, cookie) {
  const file = sessionPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ server, cookie }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function extractSession(headers) {
  const cookies = headers.getSetCookie?.() || [headers.get("set-cookie") || ""];
  for (const cookie of cookies) {
    const match = cookie.match(/(?:^|,\s*)(switchboard_session=[^;\r\n]+)/);
    if (match) return match[1];
  }
  return null;
}
async function request(server, route, { method = "GET", body, cookie, apiKey } = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${server}${route}`, {
    method, redirect: "manual", signal: AbortSignal.timeout(30000),
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Server returned invalid JSON (${response.status})`); }
  if (!response.ok) throw new Error(`Server request failed (${response.status})`);
  return { data, headers: response.headers };
}
async function authenticate(server, { authKey, save, promptKey, fetchImpl } = {}) {
  let cookie = authKey ? null : loadSession(server);
  if (!cookie) {
    const key = authKey || await promptKey();
    if (!key) throw new Error("A dashboard API key is required to create a new client key");
    const response = await request(server, "/api/auth/login", { method: "POST", body: { apiKey: key } }, fetchImpl);
    cookie = extractSession(response.headers);
    if (!cookie) throw new Error("Sign-in returned no dashboard session");
    if (save) saveSession(server, cookie);
  }
  return {
    mint: async (name) => (await request(server, "/api/keys", { method: "POST", body: { name }, cookie }, fetchImpl)).data,
    models: async (key) => (await request(server, "/api/v1/models", { apiKey: key }, fetchImpl)).data?.data || [],
    revoke: async (id) => request(server, `/api/keys/${encodeURIComponent(id)}`, { method: "DELETE", cookie }, fetchImpl),
  };
}
module.exports = { authenticate, normalizeServerUrl, loadSession, saveSession, extractSession };
