import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

describe("completed usage durability ordering", () => {
  it("awaits non-stream usage persistence before returning", () => {
    expect(read("open-sse/handlers/chatCore/nonStreamingHandler.js")).toContain("await saveUsageStats(");
    expect(read("open-sse/handlers/chatCore/sseToJsonHandler.js")).toContain("await saveUsageStats(");
  });

  it("awaits stream completion persistence before flush closes", () => {
    expect(read("open-sse/handlers/chatCore/streamingHandler.js")).toContain("const onStreamComplete = async");
    const stream = read("open-sse/utils/stream.js");
    expect(stream).toContain("async flush(controller)");
    expect(stream).toContain("await onStreamComplete(");
  });
});
