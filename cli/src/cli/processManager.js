const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

function normalizePath(value) {
  try { return path.resolve(value); } catch { return ""; }
}

function tokenizeCommand(command) {
  const tokens = [];
  let token = "";
  let quote = "";
  for (const char of String(command)) {
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }
  if (token) tokens.push(token);
  return tokens;
}

function matchesRecordedProcess({ command, cwd, expectedPath }) {
  if (!expectedPath || !command) return false;
  const expected = normalizePath(expectedPath);
  const tokens = tokenizeCommand(command);
  const scriptIndex = tokens.findIndex((token) => {
    if (!token) return false;
    if (path.isAbsolute(token)) return normalizePath(token) === expected;
    return !!cwd && normalizePath(path.join(cwd, token)) === expected;
  });
  const runtimeName = path.basename(tokens[0] || "").toLowerCase();
  const isNodeRuntime = runtimeName === "node" || runtimeName === "node.exe" || runtimeName === path.basename(process.execPath).toLowerCase();
  if (isNodeRuntime && scriptIndex > 0 && tokens.slice(1, scriptIndex).every((token) => token.startsWith("-"))) {
    return true;
  }

  const expectedName = path.basename(expectedPath);
  const isBundledServer = expectedName === "server.js" || expectedName === "custom-server.js";
  if (!isBundledServer || !/^next-server(?:\s|\(|$)/.test(command.trim())) return false;

  return !!cwd && normalizePath(cwd) === normalizePath(path.dirname(expectedPath));
}

function getProcessCommand(pid) {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell", [
        "-NonInteractive", "-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`,
      ], { encoding: "utf8", windowsHide: true, timeout: 3000 }).trim();
    }
    return execFileSync("ps", ["-p", String(Number(pid)), "-o", "command="], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch { return ""; }
}

function getProcessCwd(pid) {
  try {
    if (process.platform === "linux") return fs.readlinkSync(`/proc/${Number(pid)}/cwd`);
    if (process.platform === "win32") return "";
    const output = execFileSync("lsof", ["-a", "-p", String(Number(pid)), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const cwdLine = output.split(/\r?\n/).find((line) => line.startsWith("n"));
    return cwdLine ? cwdLine.slice(1) : "";
  } catch { return ""; }
}

function processMatchesRecordedPath(pid, expectedPath) {
  const command = getProcessCommand(pid);
  if (matchesRecordedProcess({ command, cwd: "", expectedPath })) return true;
  return matchesRecordedProcess({ command, cwd: getProcessCwd(pid), expectedPath });
}

function findListeningPids(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return [];
  try {
    if (process.platform === "win32") {
      const output = execFileSync("powershell", [
        "-NonInteractive", "-NoProfile", "-Command",
        `Get-NetTCPConnection -LocalPort ${numericPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
      ], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      return output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 1);
    }
    const output = execFileSync("lsof", [`-tiTCP:${numericPort}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 1);
  } catch { return []; }
}

function isPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLifecycleLock(dataDir, { instanceId, timeoutMs = 10000 } = {}) {
  const lockDir = path.join(dataDir, "runtime", "lifecycle.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, instanceId, createdAt: Date.now() }), { mode: 0o600 });
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
          if (owner.instanceId === instanceId) fs.rmSync(lockDir, { recursive: true, force: true });
        } catch { /* lock already released */ }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); } catch { /* incomplete or stale lock */ }
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* retry */ }
      const stale = owner?.pid ? !isPidAlive(owner.pid) : ageMs > 1000;
      if (stale) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* another waiter won */ }
        continue;
      }
      await sleep(100);
    }
  }
  throw new Error("Another Switchboard lifecycle operation is still in progress; retry shortly");
}

async function terminatePid(pid, { timeoutMs = 2000, processGroup = false } = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 1 || numericPid === process.pid) return false;
  const unixTarget = processGroup && process.platform !== "win32" ? -numericPid : numericPid;
  const targetIsAlive = () => isPidAlive(unixTarget);
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /PID ${numericPid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
    } else {
      process.kill(unixTarget, "SIGTERM");
    }
  } catch { /* already stopped or inaccessible */ }

  const deadline = Date.now() + timeoutMs;
  while (targetIsAlive() && Date.now() < deadline) await sleep(100);
  if (!targetIsAlive()) return true;

  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${numericPid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
    } else {
      process.kill(unixTarget, "SIGKILL");
    }
  } catch { /* best effort */ }
  return !targetIsAlive();
}

module.exports = {
  acquireLifecycleLock,
  findListeningPids,
  getProcessCommand,
  getProcessCwd,
  isPidAlive,
  matchesRecordedProcess,
  processMatchesRecordedPath,
  terminatePid,
};
