import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { parseConnectRPCFrame, decodeMessage } from "../../open-sse/utils/cursorProtobuf.js";

const frame = (flags, payload) => {
  const buf = Buffer.alloc(5 + payload.length);
  buf[0] = flags;
  buf.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(buf, 5);
  return new Uint8Array(buf);
};

/**
 * Regression: when gunzip threw, parseConnectRPCFrame logged and returned the
 * still-compressed bytes as `payload`. Callers then ran decodeMessage() over
 * gzip data and emitted whatever fields it happened to hallucinate.
 */
describe("parseConnectRPCFrame gzip handling", () => {
  it("decompresses a valid gzip frame", () => {
    const inner = Buffer.from([0x1a, 0x03, 0x61, 0x62, 0x63]); // field 3, len 3, "abc"
    const parsed = parseConnectRPCFrame(frame(0x01, zlib.gzipSync(inner)));
    expect(parsed.decompressFailed).toBe(false);
    expect(Buffer.from(parsed.payload).equals(inner)).toBe(true);
  });

  it("yields an empty payload — not the raw gzip bytes — when gunzip fails", () => {
    const garbage = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const parsed = parseConnectRPCFrame(frame(0x01, garbage));

    expect(parsed).not.toBeNull();
    expect(parsed.decompressFailed).toBe(true);
    expect(parsed.payload.length).toBe(0);
    expect(decodeMessage(parsed.payload).size).toBe(0);
    // consumed still advances so the caller can move to the next frame
    expect(parsed.consumed).toBe(5 + garbage.length);
  });
});
