import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { POST } = await import("../../src/app/api/shutdown/route.js");

function post(authorization) {
  const headers = { host: "localhost:20128" };
  if (authorization) headers.authorization = authorization;
  return new Request("http://localhost:20128/api/shutdown", { method: "POST", headers });
}

describe("POST /api/shutdown (A12)", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSecret = process.env.SHUTDOWN_SECRET;
  let kill;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    process.env.SHUTDOWN_SECRET = "dev-secret";
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    kill.mockRestore();
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
    if (originalSecret === undefined) delete process.env.SHUTDOWN_SECRET;
    else process.env.SHUTDOWN_SECRET = originalSecret;
  });

  it("returns {success:true} with the correct Bearer [REDACTED] schedules SIGTERM", async () => {
    const res = await POST(post(`Bearer ${process.env.SHUTDOWN_SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: "Shutting down..." });
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("rejects a wrong secret with 401 and never kills", async () => {
    const res = await POST(post("Bearer [REDACTED]"));
    expect(res.status).toBe(401);
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses to shut down in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await POST(post(`Bearer ${process.env.SHUTDOWN_SECRET}`));
    expect(res.status).toBe(403);
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).not.toHaveBeenCalled();
  });
});
