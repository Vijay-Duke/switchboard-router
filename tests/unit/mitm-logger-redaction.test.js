import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dumpRequest, createResponseDumper } = require("../../src/mitm/logger.js");

const createdFiles = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try { fs.unlinkSync(file); } catch {}
  }
});

function fakeReq(url = "/v1/chat?key=SECRET-KEY-123") {
  return {
    method: "POST",
    url,
    headers: {
      host: "api.individual.githubcopilot.com",
      authorization: "Bearer COPILOT-TOKEN-ABC",
      cookie: "session=super-secret",
      "content-type": "application/json",
    },
  };
}

describe("mitm logger redaction (L16)", () => {
  it("strips bearer, cookie and ?key= from dumped requests", () => {
    const file = dumpRequest(
      fakeReq(),
      Buffer.from(JSON.stringify({ token: "tok-999", prompt: "hello" }))
    );
    expect(file).toBeTruthy();
    createdFiles.push(file);
    const dumped = fs.readFileSync(file, "utf8");
    expect(dumped).not.toContain("COPILOT-TOKEN-ABC");
    expect(dumped).not.toContain("super-secret");
    expect(dumped).not.toContain("SECRET-KEY-123");
    expect(dumped).not.toContain("tok-999");
    expect(dumped).toContain("[REDACTED]");
    // Non-secret content survives.
    expect(dumped).toContain("hello");
    expect(dumped).toContain("application/json");
  });

  it("redacts response headers and bodies", () => {
    const req = fakeReq("/generateAssistantResponse");
    const dumper = createResponseDumper(req);
    expect(dumper).toBeTruthy();
    createdFiles.push(dumper.file);
    dumper.writeHeader(200, {
      "content-type": "application/json",
      "set-cookie": "session=super-secret",
    });
    dumper.writeChunk(Buffer.from(JSON.stringify({ access_token: "KIRO-TOKEN-XYZ", text: "world" })));
    dumper.end();
    const dumped = fs.readFileSync(dumper.file, "utf8");
    expect(dumped).not.toContain("super-secret");
    expect(dumped).not.toContain("KIRO-TOKEN-XYZ");
    expect(dumped).toContain("world");
  });

  it("redacts inline Bearer material in non-JSON bodies", () => {
    const file = dumpRequest(fakeReq("/plain"), Buffer.from("Authorization: Bearer RAW-TOKEN-456"));
    expect(file).toBeTruthy();
    createdFiles.push(file);
    const dumped = fs.readFileSync(file, "utf8");
    expect(dumped).not.toContain("RAW-TOKEN-456");
  });
});
