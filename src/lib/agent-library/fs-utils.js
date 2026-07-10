// @ts-check
/**
 * Shared filesystem helpers for Agent Library:
 * - atomic file writes (tmp + rename)
 * - process-wide exclusive lock for apply/clean (in-process queue + file lock)
 */
import fs from "node:fs/promises";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { getLibraryRoot } from "./paths.js";
export { atomicWriteFile } from "@/lib/atomicWriteFile.js";

const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_POLL_MS = 50;
const LOCK_WAIT_MS = 30_000;

/** @type {Promise<void>} */
let processChain = Promise.resolve();

function controlLockPath() {
  const root = getLibraryRoot({ scope: "global", projectPath: null });
  return path.join(root, ".apply.lock");
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to create exclusive lock file. Returns true if acquired.
 * @param {string} lockPath
 */
function tryAcquireFileLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    at: new Date().toISOString(),
    ts: Date.now(),
  });
  try {
    // O_EXCL — atomic claim
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, payload, "utf-8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    return false;
  }
}

/**
 * Steal lock if stale (dead pid or too old).
 * @param {string} lockPath
 */
function tryStealStaleLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, "utf-8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { pid: parseInt(String(raw).trim(), 10), ts: 0 };
    }
    const pid = Number(data.pid);
    const ts = Number(data.ts) || 0;
    const staleByAge = ts > 0 && Date.now() - ts > LOCK_STALE_MS;
    const staleByPid = !isPidAlive(pid);
    if (staleByAge || staleByPid) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* race */
      }
      return tryAcquireFileLock(lockPath);
    }
  } catch {
    /* unreadable → try steal */
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return tryAcquireFileLock(lockPath);
  }
  return false;
}

/**
 * Block until exclusive file lock acquired, then return release fn.
 * @returns {Promise<() => void>}
 */
async function acquireFileLock() {
  const lockPath = controlLockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (tryAcquireFileLock(lockPath) || tryStealStaleLock(lockPath)) {
      return () => {
        try {
          if (!existsSync(lockPath)) return;
          const raw = readFileSync(lockPath, "utf-8");
          try {
            const data = JSON.parse(raw);
            if (data.pid === process.pid) unlinkSync(lockPath);
          } catch {
            if (String(raw).trim() === String(process.pid)) unlinkSync(lockPath);
          }
        } catch {
          /* ignore */
        }
      };
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  const err = new Error(
    "Agent Library apply/clean is already running (lock timeout). Retry shortly."
  );
  // @ts-ignore
  err.code = "lock_timeout";
  throw err;
}

/**
 * Serialize apply/clean (and other mutating ops) in-process and across
 * concurrent Node workers that share the data dir via a file lock.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withAgentLibraryLock(fn) {
  /** @type {(v: T) => void} */
  let resolveOuter;
  /** @type {(e: any) => void} */
  let rejectOuter;
  const result = new Promise((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });

  processChain = processChain
    .then(async () => {
      const release = await acquireFileLock();
      try {
        const value = await fn();
        resolveOuter(value);
      } catch (e) {
        rejectOuter(e);
      } finally {
        release();
      }
    })
    .catch(() => {
      /* keep chain alive after lock acquire failures already rejected outer */
    });

  return result;
}
