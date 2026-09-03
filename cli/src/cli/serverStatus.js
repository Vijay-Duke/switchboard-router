const http = require("http");
const net = require("net");
const MAX_RESPONSE_BYTES = 64 * 1024;

function requestJson({ hostname = "127.0.0.1", port, path, timeoutMs = 1000 }) {
  // Lazily required so the data-dir resolution (and its tests) can point
  // DATA_DIR at a temp dir before this module is first used. The CLI token
  // lets probes authenticate against local-only routes from any peer, which
  // keeps health and version probes working on explicit LAN binds.
  const { CLI_TOKEN_HEADER, getCliToken } = require("./api/client");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request({
      hostname,
      port,
      path,
      method: "GET",
      headers: { Accept: "application/json", [CLI_TOKEN_HEADER]: getCliToken() },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
          res.destroy(new Error("response too large"));
          finish(null);
        }
      });
      res.on("aborted", () => finish(null));
      res.on("error", () => finish(null));
      res.on("end", () => {
        try {
          finish({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch {
          finish(null);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
    req.end();
  });
}

function probeTcp(port, timeoutMs = 1000, hostname = "127.0.0.1") {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: hostname, port });
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function probeHealth(port, timeoutMs = 1000, hostname = "127.0.0.1") {
  const response = await requestJson({ hostname, port, path: "/api/health", timeoutMs });
  return response?.statusCode === 200 && response?.body?.ok === true;
}

async function probeSwitchboard(port, timeoutMs = 1000, hostname = "127.0.0.1") {
  const response = await requestJson({ hostname, port, path: "/api/mgmt/v1/version", timeoutMs });
  const data = response?.body?.data;
  if (response?.statusCode === 200 && data?.name === "switchboard-app") return data;

  // Compatibility with older bundles that predate the management version API.
  if (await probeHealth(port, timeoutMs, hostname)) {
    return { name: "switchboard-app", version: null, startedAt: null, legacyHealth: true };
  }
  return null;
}

async function waitForSwitchboard(port, { timeoutMs = 20000, intervalMs = 250, hostname = "127.0.0.1", acceptTcpFallback = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await probeSwitchboard(port, Math.min(1000, intervalMs * 2), hostname);
    if (status) return status;
    if (acceptTcpFallback && await probeTcp(port, Math.min(1000, intervalMs * 2), hostname) && await acceptTcpFallback()) {
      return { name: "switchboard-app", version: null, startedAt: null, tcpOnly: true };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function startHealthWatchdog({
  port,
  hostname = "127.0.0.1",
  graceMs = 60_000,
  intervalMs = 10_000,
  timeoutMs = 2_000,
  maxFailures = 3,
  probe = probeHealth,
  onUnhealthy,
  onHealthy,
} = {}) {
  let stopped = false;
  let timer = null;
  let failures = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      const status = await probe(port, timeoutMs, hostname).catch(() => null);
      if (status) {
        failures = 0;
        try {
          await onHealthy?.();
        } catch (error) {
          console.error("[watchdog] onHealthy failed:", error?.message || error);
        }
      } else failures++;

      if (failures >= maxFailures) {
        failures = 0;
        try {
          await onUnhealthy?.();
        } catch (error) {
          console.error("[watchdog] onUnhealthy failed:", error?.message || error);
        }
        if (stopped) return;
      }
    } catch (error) {
      // A probe that throws synchronously must not become an unhandled
      // rejection (the launcher would treat it as fatal).
      console.error("[watchdog] probe failed:", error?.message || error);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, graceMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { probeHealth, probeSwitchboard, probeTcp, startHealthWatchdog, waitForSwitchboard };
