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
