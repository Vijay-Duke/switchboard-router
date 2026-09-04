import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCombos: vi.fn(),
  getComboById: vi.fn(),
  getSettings: vi.fn(),
  createComboWrite: vi.fn(),
  updateComboWrite: vi.fn(),
  hasValidCliToken: vi.fn(),
  countRoutingAttempts: vi.fn(),
  countRoutingEvents: vi.fn(),
  getModelPerfStats: vi.fn(),
  getScoreTrendByDay: vi.fn(),
  listCombosWithRoutingEvents: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

vi.mock("@/lib/db/index.js", () => ({
  getCombos: mocks.getCombos,
  getComboById: mocks.getComboById,
  getSettings: mocks.getSettings,
}));
vi.mock("@/lib/combos/comboWrites.js", () => ({
  ComboWriteError: class ComboWriteError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  },
  createComboWrite: mocks.createComboWrite,
  updateComboWrite: mocks.updateComboWrite,
}));
vi.mock("@/shared/utils/cliToken.js", () => ({ hasValidCliToken: mocks.hasValidCliToken }));
vi.mock("@/lib/db/repos/routingRepo.js", () => ({
  countRoutingAttempts: mocks.countRoutingAttempts,
  countRoutingEvents: mocks.countRoutingEvents,
  getModelPerfStats: mocks.getModelPerfStats,
  getScoreTrendByDay: mocks.getScoreTrendByDay,
  listCombosWithRoutingEvents: mocks.listCombosWithRoutingEvents,
}));

const combosRoute = await import("../../src/app/api/mgmt/v1/combos/route.js");
const comboByIdRoute = await import("../../src/app/api/mgmt/v1/combos/[id]/route.js");
const routingRoute = await import("../../src/app/api/mgmt/v1/routing/route.js");

function remoteRequest(url, body, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", host: "router.example.com" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function localRequest(url, body, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", host: "localhost:20128" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("mgmt combos auth enforcement (A1/A2)", () => {
  const originalHostname = process.env.HOSTNAME;
  const originalManagementToken = process.env.MANAGEMENT_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOSTNAME = "127.0.0.1";
    delete process.env.MANAGEMENT_TOKEN;
    mocks.hasValidCliToken.mockResolvedValue(false);
  });

  afterEach(() => {
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
    if (originalManagementToken === undefined) delete process.env.MANAGEMENT_TOKEN;
    else process.env.MANAGEMENT_TOKEN = originalManagementToken;
  });

  it("A1: unauthenticated remote POST returns 401 with the {v:1,error} envelope", async () => {
    mocks.createComboWrite.mockResolvedValue({ id: "x", name: "x" });
    const res = await combosRoute.POST(
      remoteRequest("http://router.example.com/api/mgmt/v1/combos", { name: "evil" }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.error.code).toBe("unauthorized");
    expect(typeof body.error.message).toBe("string");
    expect(mocks.createComboWrite).not.toHaveBeenCalled();
  });

  it("A1: authenticated POST returns 201", async () => {
    process.env.MANAGEMENT_TOKEN = "management-secret";
    mocks.createComboWrite.mockResolvedValue({ id: "c1", name: "good" });
    const req = remoteRequest("http://router.example.com/api/mgmt/v1/combos", { name: "good" });
    req.headers.set("authorization", `Bearer ${process.env.MANAGEMENT_TOKEN}`);
    const res = await combosRoute.POST(req);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ v: 1, data: { id: "c1", name: "good" } });
  });

  it("A2: unauthenticated remote PUT returns 401", async () => {
    mocks.updateComboWrite.mockResolvedValue({ id: "c1", name: "c1" });
    const res = await comboByIdRoute.PUT(
      remoteRequest("http://router.example.com/api/mgmt/v1/combos/c1", { name: "evil" }, "PUT"),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(401);
    expect(mocks.updateComboWrite).not.toHaveBeenCalled();
  });

  it("A2: authenticated PUT returns 200", async () => {
    process.env.MANAGEMENT_TOKEN = "management-secret";
    mocks.updateComboWrite.mockResolvedValue({ id: "c1", name: "renamed" });
    const req = remoteRequest("http://router.example.com/api/mgmt/v1/combos/c1", { name: "renamed" }, "PUT");
    req.headers.set("authorization", `Bearer ${process.env.MANAGEMENT_TOKEN}`);
    const res = await comboByIdRoute.PUT(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 1, data: { id: "c1", name: "renamed" } });
  });
});

describe("mgmt combos id validation (A3)", () => {
  const originalHostname = process.env.HOSTNAME;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOSTNAME = "127.0.0.1";
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.getComboById.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  });

  it.each(["", "   ", "x".repeat(201)])("rejects id %p with 400", async (id) => {
    const res = await comboByIdRoute.GET(
      localRequest("http://localhost:20128/api/mgmt/v1/combos/x", undefined, "GET"),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      v: 1,
      error: { message: "Invalid combo id", code: "bad_request" },
    });
    expect(mocks.getComboById).not.toHaveBeenCalled();
  });
});

describe("mgmt routing days clamp (A4)", () => {
  const originalHostname = process.env.HOSTNAME;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOSTNAME = "127.0.0.1";
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.getModelPerfStats.mockResolvedValue([]);
    mocks.countRoutingEvents.mockResolvedValue(0);
    mocks.countRoutingAttempts.mockResolvedValue(0);
    mocks.getScoreTrendByDay.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  });

  it("floors fractional days", async () => {
    const res = await routingRoute.GET(
      localRequest("http://localhost:20128/api/mgmt/v1/routing?combo=c&days=2.9", undefined, "GET"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.days).toBe(2);
  });
});
