// @ts-check

import fs from "node:fs/promises";
import { atomicWriteFile } from "@/lib/atomicWriteFile.js";

/**
 * Atomically replace a CLI configuration file. Secret-bearing files are
 * created and retained as owner-only even when an existing file was broader.
 *
 * @param {string} filePath
 * @param {string|Buffer} content
 * @param {{ secret?: boolean }} [options]
 */
export async function writeCliFile(filePath, content, { secret = false } = {}) {
  await atomicWriteFile(
    filePath,
    content,
    secret ? { encoding: "utf-8", mode: 0o600 } : "utf-8",
  );
  if (secret) {
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Windows and some virtual filesystems do not implement POSIX modes.
    }
  }
}

/**
 * Replace several related CLI files as one recoverable operation. Each file is
 * atomically replaced; if a later replacement fails, every prior file is
 * restored to its exact previous bytes (or removed if it did not exist).
 *
 * @param {Array<{ filePath: string, content: string|Buffer|null, secret?: boolean }>} operations
 */
export async function replaceCliFiles(operations) {
  const snapshots = await Promise.all(operations.map(async ({ filePath }) => {
    try {
      return { exists: true, value: await fs.readFile(filePath) };
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, value: null };
      throw error;
    }
  }));

  const apply = async ({ filePath, content, secret = false }) => {
    if (content !== null) {
      await writeCliFile(filePath, content, { secret });
      return;
    }
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };

  try {
    for (const operation of operations) await apply(operation);
  } catch (error) {
    const rollback = await Promise.allSettled(operations.map(({ filePath, secret = false }, index) => (
      apply({
        filePath,
        content: snapshots[index].exists ? snapshots[index].value : null,
        secret,
      })
    )));
    const failures = rollback.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures.map((result) => result.reason)],
        "Failed to replace CLI files and roll them back cleanly",
      );
    }
    throw error;
  }
}

/**
 * @param {Record<string, any>} value
 * @param {string[]} keys
 */
export function snapshotObjectKeys(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, {
    exists: Object.hasOwn(value, key),
    value: value[key],
  }]));
}

/**
 * @param {Record<string, any>} value
 * @param {Record<string, { exists?: boolean, value?: any }> | null | undefined} snapshot
 */
export function restoreObjectKeys(value, snapshot) {
  for (const [key, entry] of Object.entries(snapshot || {})) {
    if (entry?.exists) value[key] = entry.value;
    else delete value[key];
  }
}
