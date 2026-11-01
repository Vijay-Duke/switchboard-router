// Host-aware V8 old-space sizing. Mirror of scripts/heapSizing.mjs — the CLI
// package is packed separately and cannot import from the app repo, so keep
// the semantics identical: explicit SWITCHBOARD_MAX_OLD_SPACE_MB wins, else
// half of host RAM clamped to [512, 6144] MB. A fixed 6144 invites the kernel
// OOM killer on small hosts long before V8 feels GC pressure.
const os = require("node:os");

function nodeOptionsHasMaxOldSpace(env = process.env) {
  return /--max-old-space-size(?:=|\s)/.test((env && env.NODE_OPTIONS) || "");
}

function resolveMaxOldSpaceMb({ env = process.env, totalMemBytes } = {}) {
  const override = Number.parseInt((env && env.SWITCHBOARD_MAX_OLD_SPACE_MB) || "", 10);
  if (Number.isFinite(override) && override >= 256) return override;

  let total = Number.isFinite(totalMemBytes) && totalMemBytes > 0 ? totalMemBytes : null;
  if (!total) {
    try {
      const detected = os.totalmem();
      if (Number.isFinite(detected) && detected > 0) total = detected;
    } catch { /* fall through to fallback */ }
  }
  if (!total) return 2048;
  const halfMb = Math.floor(total / (1024 * 1024) / 2);
  return Math.min(6144, Math.max(512, halfMb));
}

/** Node CLI args to prepend, or [] when the operator already set a heap flag. */
function maxOldSpaceArgs(options = {}) {
  const env = options.env ?? process.env;
  if (nodeOptionsHasMaxOldSpace(env)) return [];
  return [`--max-old-space-size=${resolveMaxOldSpaceMb(options)}`];
}

module.exports = { resolveMaxOldSpaceMb, nodeOptionsHasMaxOldSpace, maxOldSpaceArgs };
