/** True while `next build` collects pages / prerenders. Nothing here may touch the live data directory. */
export function isBuildPhase() {
  return process.env.NEXT_PHASE === "phase-production-build"
    || process.env.NEXT_PHASE === "phase-export"
    || process.env.NEXT_PHASE === "phase-static";
}
