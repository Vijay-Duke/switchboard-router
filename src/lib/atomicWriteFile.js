// @ts-check

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write a file to a sibling temporary path, fsync it, then atomically replace
 * the destination. This prevents truncated configuration after a crash.
 *
 * @param {string} filePath
 * @param {string|Buffer} content
 * @param {import("node:fs").WriteFileOptions} [options]
 */
export async function atomicWriteFile(filePath, content, options = "utf-8") {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.sb-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    await fs.writeFile(tmp, content, options);
    try {
      const handle = await fs.open(tmp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Some virtual filesystems do not support fsync.
    }
    await fs.rename(tmp, filePath);
  } catch (error) {
    try {
      await fs.unlink(tmp);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}
