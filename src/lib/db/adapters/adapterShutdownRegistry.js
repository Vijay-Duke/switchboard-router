const registryKey = Symbol.for("switchboard.adapterShutdownRegistry");

const registry = globalThis[registryKey] ??= {
  closers: new Set(),
  listener: null,
};

if (!registry.listener) {
  registry.listener = () => {
    for (const closer of [...registry.closers]) {
      if (!registry.closers.delete(closer)) continue;
      try { closer(); } catch {}
    }
  };
  process.on("beforeExit", registry.listener);
}

export function registerAdapterCloser(closer) {
  registry.closers.add(closer);
  let registered = true;

  return () => {
    if (!registered) return false;
    registered = false;
    return registry.closers.delete(closer);
  };
}
