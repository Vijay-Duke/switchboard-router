// W9: /api/version memoizes the npm registry lookup (1h TTL), serves the
// stale entry when the registry fails, and never caches a miss. Module
// state is reset per test via vi.resetModules() + a fresh import, so the
// route needs no test-only reset export.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOUR_MS = 60 * 60 * 1000;
let httpsGet;

vi.mock("https", () => ({
  default: { get: (...args) => httpsGet(...args) },
}));

function fakeReq() {
  const handlers = {};
  return {
    handlers,
    on(ev, fn) {
      handlers[ev] = fn;
      return this;
    },
    destroy() {},
  };
}

/** Registry answers `status` with `body` (JSON). */
function registryResponds(status, body) {
  return vi.fn((url, opts, cb) => {
    const handlers = {};
    const res = {
      statusCode: status,
      on(ev, fn) {
        handlers[ev] = fn;
        return this;
      },
      resume() {},
    };
    Promise.resolve().then(() => {
      cb(res);
      if (status < 400) {
        handlers.data?.(JSON.stringify(body));
        handlers.end?.();
      }
    });
    return fakeReq();
  });
}

/** Registry unreachable: the request errors out. */
function registryDown() {
  return vi.fn(() => {
    const req = fakeReq();
    Promise.resolve().then(() => req.handlers.error?.(new Error("ECONNREFUSED")));
    return req;
  });
}

const OURS = {
  version: "999.0.0",
  name: "switchboard-router",
  description: "Switchboard routing gateway",
};

async function freshGet() {
  vi.resetModules();
  const mod = await import("@/app/api/version/route.js");
  return mod.GET;
}

let now;

beforeEach(() => {
  delete process.env.SWITCHBOARD_NPM_PACKAGE;
  delete process.env.NPM_UPDATE_PACKAGE;
  now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("version route server cache (W9)", () => {
  it("memoizes a successful lookup: two requests, one registry hit", async () => {
    httpsGet = registryResponds(200, OURS);
    const GET = await freshGet();
    const a = await (await GET()).json();
    const b = await (await GET()).json();
    expect(httpsGet).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ latestVersion: "999.0.0", hasUpdate: true });
    expect(b).toEqual(a);
  });

  it("re-fetches after the one-hour TTL expires", async () => {
    httpsGet = registryResponds(200, OURS);
    const GET = await freshGet();
    await GET();
    now += HOUR_MS - 1;
    await GET();
    expect(httpsGet).toHaveBeenCalledTimes(1);
    now += 2;
    await GET();
    expect(httpsGet).toHaveBeenCalledTimes(2);
  });

  it("serves the stale payload when the registry fails after expiry", async () => {
    httpsGet = registryResponds(200, OURS);
    const GET = await freshGet();
    await GET();
    now += HOUR_MS + 1;
    httpsGet = registryDown();
    const stale = await (await GET()).json();
    expect(httpsGet).toHaveBeenCalledTimes(1);
    expect(stale).toMatchObject({ latestVersion: "999.0.0", hasUpdate: true });
    expect(stale.reason).toBeUndefined();
  });

  it("never caches a miss: a failed first lookup is retried on the next request", async () => {
    httpsGet = registryDown();
    const GET = await freshGet();
    const miss = await (await GET()).json();
    expect(miss).toMatchObject({ latestVersion: null, hasUpdate: false, reason: "registry_unavailable" });
    httpsGet = registryResponds(200, OURS);
    const hit = await (await GET()).json();
    expect(httpsGet).toHaveBeenCalledTimes(1);
    expect(hit).toMatchObject({ latestVersion: "999.0.0", hasUpdate: true });
  });

  it("does not cache a 404 either", async () => {
    httpsGet = registryResponds(404, {});
    const GET = await freshGet();
    await GET();
    await GET();
    expect(httpsGet).toHaveBeenCalledTimes(2);
  });

  it("keeps no test-only reset export in the route module", async () => {
    const mod = await import("@/app/api/version/route.js");
    expect(Object.keys(mod).filter((k) => k.startsWith("__"))).toEqual([]);
  });
});
