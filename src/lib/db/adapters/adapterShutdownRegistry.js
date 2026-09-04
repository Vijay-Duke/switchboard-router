const registryKey = Symbol.for("switchboard.adapterShutdownRegistry");

const registry = globalThis[registryKey] ??= {
  closers: new Set(),
  flushers: new Set(),
  listener: null,
  signalHandlers: null,
};
// A registry object created by an older module version (dev hot-reload) may
// predate the flushers phase.
registry.flushers ??= new Set();

// Flushers (buffered writers such as requestDetailsRepo) drain into the
// adapters first; adapter closers run second. Registration order alone cannot
// guarantee that: the repo re-registers on every hot reload and would land
// after the adapter, then flush into an already-closed database.
function runClosersSync() {
  for (const set of [registry.flushers, registry.closers]) {
    for (const fn of [...set]) {
      if (!set.delete(fn)) continue;
      try { fn(); } catch {}
    }
  }
}

if (!registry.listener) {
  registry.listener = () => {
    runClosersSync();
  };
  process.on("beforeExit", registry.listener);

  // Node never fires beforeExit on SIGTERM/SIGINT/process.exit(), so a
  // beforeExit-only flush loses sql.js's debounced persist and buffered
  // observability rows on every docker stop / restart. Run the same closers
  // synchronously on signals, then step aside. When another listener remains
  // (Next.js cleanup, initializeApp's shutdown handler) it owns the exit;
  // otherwise re-raise so the process still dies by signal with the default
  // disposition.
  const onSignal = (sig) => {
    runClosersSync();
    if (registry.signalHandlers) {
      process.removeListener("SIGTERM", registry.signalHandlers.onSigterm);
      process.removeListener("SIGINT", registry.signalHandlers.onSigint);
      registry.signalHandlers = null;
    }
    if (process.listenerCount(sig) > 0) return;
    try {
      process.kill(process.pid, sig);
    } catch {
      process.exit(sig === "SIGINT" ? 130 : 143);
    }
  };
  const onSigterm = () => onSignal("SIGTERM");
  const onSigint = () => onSignal("SIGINT");
  registry.signalHandlers = { onSigterm, onSigint };
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
}

/**
 * @param {() => void} closer
 * @param {{ flush?: boolean }} [opts] flush=true runs before every adapter closer.
 */
export function registerAdapterCloser(closer, { flush = false } = {}) {
  const set = flush ? registry.flushers : registry.closers;
  set.add(closer);
  let registered = true;

  return () => {
    if (!registered) return false;
    registered = false;
    return set.delete(closer);
  };
}
