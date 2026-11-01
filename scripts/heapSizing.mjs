// Host-aware V8 old-space sizing for the standalone launchers.
//
// A fixed --max-old-space-size=6144 is right on a 24 GB host and dangerous on
// a 2 GB VPS (the kernel OOM killer fires before V8 GC pressure does). Scale
// with RAM: half of total memory, clamped to [512, 6144] MB. An explicit
// SWITCHBOARD_MAX_OLD_SPACE_MB always wins; an operator-supplied NODE_OPTIONS
// flag suppresses ours entirely. Mirrored in cli/src/shared/heapSize.js (the
// CLI package is packed separately and cannot import from scripts/).
import os from "node:os";

export const MIN_OLD_SPACE_MB = 512;
export const MAX_OLD_SPACE_MB = 6144;
export const FALLBACK_OLD_SPACE_MB = 2048;

export function nodeOptionsHasMaxOldSpace(env = process.env) {
  return /--max-old-space-size(?:=|\s)/.test(env?.NODE_OPTIONS || "");
}

export function resolveMaxOldSpaceMb({ env = process.env, totalMemBytes } = {}) {
  const override = Number.parseInt(env?.SWITCHBOARD_MAX_OLD_SPACE_MB || "", 10);
  if (Number.isFinite(override) && override >= 256) return override;

  const total = Number.isFinite(totalMemBytes) && totalMemBytes > 0 ? totalMemBytes : safeTotalMem();
  if (!total) return FALLBACK_OLD_SPACE_MB;
  const halfMb = Math.floor(total / (1024 * 1024) / 2);
  return Math.min(MAX_OLD_SPACE_MB, Math.max(MIN_OLD_SPACE_MB, halfMb));
}

function safeTotalMem() {
  try {
    const total = os.totalmem();
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch {
    return null;
  }
}

/** Node CLI args to prepend, or [] when the operator already set a heap flag. */
export function maxOldSpaceArgs(options = {}) {
  const env = options.env ?? process.env;
  if (nodeOptionsHasMaxOldSpace(env)) return [];
  return [`--max-old-space-size=${resolveMaxOldSpaceMb(options)}`];
}
