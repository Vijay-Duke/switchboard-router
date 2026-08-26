// RTK telemetry persistence: rtk stats attached to a request detail must
// survive the write-buffer → flush allowlist → data JSON → read round-trip.
// Guards the allowlist in requestDetailsRepo.flushToDatabase: a field added
// to buildRequestDetail but missing from the flush record is silently dropped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-rtk-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("RTK telemetry persistence", () => {
  it("persists rtk stats through saveRequestDetail → getRequestDetails", async () => {
    const { saveRequestDetail, getRequestDetails, flushPendingRequestDetails } =
      await import("@/lib/db/repos/requestDetailsRepo.js");
    const { buildRequestDetail } = await import("open-sse/handlers/chatCore/requestDetail.js");

    const rtk = { bytesBefore: 1000, bytesAfter: 400, hits: ["gitDiff"] };
    await saveRequestDetail(buildRequestDetail({
      provider: "rtk-test",
      model: "m1",
      connectionId: "c1",
      request: { messages: [] },
      response: { error: "boom" },
      status: "error",
      rtk,
    }));
    await flushPendingRequestDetails();

    const { details } = await getRequestDetails({ provider: "rtk-test" });
    expect(details).toHaveLength(1);
    expect(details[0].rtk).toEqual(rtk);
  }, 15000);

  it("omits rtk when absent (no undefined key in stored JSON)", async () => {
    const { saveRequestDetail, getRequestDetails, flushPendingRequestDetails } =
      await import("@/lib/db/repos/requestDetailsRepo.js");
    const { buildRequestDetail } = await import("open-sse/handlers/chatCore/requestDetail.js");

    await saveRequestDetail(buildRequestDetail({
      provider: "rtk-test",
      model: "m1",
      request: { messages: [] },
      response: {},
      status: "success",
    }));
    await flushPendingRequestDetails();

    const { details } = await getRequestDetails({ provider: "rtk-test" });
    expect(details).toHaveLength(1);
    expect(details[0].rtk).toBeUndefined();
  }, 15000);
});
