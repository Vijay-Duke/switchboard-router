import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const CLIENT = "src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js";

describe("basic chat QA fixes (2026-08-22 audit)", () => {
  it("QA-001: posts to the implemented same-origin gateway chat endpoint", () => {
    const src = source(CLIENT);
    expect(src).toContain('fetch("/v1/chat/completions"');
    expect(src).not.toContain("/api/dashboard/chat/completions");
  });

  it("QA-001: sends the user-facing model string, not the provider-node internal id", () => {
    const src = source(CLIENT);
    // Model ids are built from the node's public prefix (providerSpecificData.prefix)
    // with the internal node id only as a fallback.
    expect(src).toContain("textValue(connection?.providerSpecificData?.prefix)");
    // Both static and live model normalization route through the prefix helper.
    expect(src).toContain("const requestModel = `${getRequestModelPrefix(connection)}/${model.id}`;");
    expect(src).toContain("requestModel = `${aliasPrefix}/${rawId}`;");
    // The request body carries the resolved user-facing model string.
    expect(src).toContain("model: model.requestModel || model.id");
    // The old internal-id prefixing is gone.
    expect(src).not.toContain("requestModel = `${connection.provider}/${rawId}`");
    expect(src).not.toContain("id: `${connection.provider}/${model.id}`");
  });

  it("QA-007: exposes a named New conversation action that preserves history", () => {
    const src = source(CLIENT);
    expect(src).toContain("New conversation");
    expect(src).toContain("onClick={handleNewChat}");
    // handleNewChat prepends a fresh session so existing ones stay in History.
    expect(src).toContain("setSessions((prev) => [session, ...prev]);\n    setActiveSessionId(session.id);\n    setActiveProviderId(session.providerId);");
  });

  it("QA-008: Stop removes the blank provisional turn or marks it stopped", () => {
    const src = source(CLIENT);
    expect(src).toContain('if (error.name === "AbortError") {');
    // Blank provisional turns are dropped; partial replies are marked stopped.
    expect(src).toContain('return textValue(message.content) ? [{ ...message, status: "stopped" }] : [];');
    // Stopped turns render a visible marker.
    expect(src).toContain("Generation stopped");
  });

  it("QA-028: composer icon buttons expose human-readable names", () => {
    const src = source(CLIENT);
    expect(src).toContain('aria-label="Attach image"');
    expect(src).toContain('aria-label="Stop generating"');
    expect(src).toContain('aria-label="Send message"');
  });
});
