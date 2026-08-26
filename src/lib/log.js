// @ts-check
/**
 * Unified log surface. Thin re-export of the existing sse logger so any code
 * path can `import { info } from "@/lib/log"` and get level filtering via
 * `LOG_LEVEL`. The sse logger keeps its emoji + tag style; this module is
 * the public entry that routes/dashboard code can depend on without
 * crossing into the sse package.
 *
 * ponytail: the 282 raw `console.*` call sites in `src/` are NOT migrated in
 * one pass. New code should import from here. Existing call sites are
 * migrated as files are touched. Add a `ponytail:` comment at any callsite
 * you intentionally leave on `console.*` so a future sweep can find it.
 */

export {
  debug,
  info,
  warn,
  error,
  request,
  response,
  stream,
  maskKey,
} from "@/sse/utils/logger.js";

/** @typedef {(method: string, path: string, extra?: unknown) => void} RequestLogger */
