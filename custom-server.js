const http = require("http");

// H1: mark that x-switchboard-real-ip is derived from the TCP socket by this wrapper.
// dashboardGuard only trusts that header when this env is set.
process.env.SWITCHBOARD_TRUST_REAL_IP = "1";

const origCreate = http.createServer.bind(http);

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-switchboard-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-switchboard-via-proxy"];
    req.headers["x-switchboard-real-ip"] = ip;
    if (viaProxy) req.headers["x-switchboard-via-proxy"] = "1";
    return handler(req, res);
  };
  return origCreate(...rest, wrapped);
};

require("./server.js");
