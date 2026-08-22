import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const componentDir = path.join(root, "src/app/(dashboard)/dashboard/cli-tools/components");
const files = fs.readdirSync(componentDir).filter((name) => name.endsWith(".js"));

describe("safe client key consumers", () => {
  it("never reads a reusable key from list records", () => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(componentDir, file), "utf8");
      expect(source, file).not.toMatch(/apiKeys(?:\?\.)?\s*\[?[^\n]*?\.key\b/);
      expect(source, file).not.toMatch(/\b(?:k|key|savedKey)\.key\b/);
    }
  });

  it("renders list metadata as prefixes and requires custom secret input", () => {
    const select = fs.readFileSync(path.join(componentDir, "ApiKeySelect.js"), "utf8");
    expect(select).toContain("keyPrefix");
    expect(select).toContain("Custom secret");
    expect(select).not.toContain("value={k.key}");
  });

  it("media examples require a pasted secret and never hydrate it from key lists", () => {
    const mediaRoot = path.join(root, "src/app/(dashboard)/dashboard/media-providers");
    const targets = [
      "[kind]/[id]/components/EmbeddingExampleCard.js",
      "[kind]/[id]/components/GenericExampleCard.js",
      "[kind]/[id]/components/SttExampleCard.js",
      "[kind]/[id]/components/TtsExampleCard.js",
      "combo/[id]/page.js",
    ];
    for (const target of targets) {
      const source = fs.readFileSync(path.join(mediaRoot, target), "utf8");
      expect(source, target).not.toContain('fetch("/api/keys"');
      expect(source, target).toContain("!apiKey.trim()");
    }
  });

  it("covers repository, CLI, dashboard, media, and real-test consumers", () => {
    const targets = {
      repository: "src/lib/db/repos/apiKeysRepo.js",
      cli: "cli/src/cli/menus/apiKeys.js",
      dashboard: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
      media: "src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/EmbeddingExampleCard.js",
      realTest: "tests/translator/real/nvidia-thinking.e2e.test.js",
    };
    const sources = Object.fromEntries(
      Object.entries(targets).map(([name, file]) => [name, fs.readFileSync(path.join(root, file), "utf8")]),
    );

    expect(sources.repository).toContain("rotationRequired");
    expect(sources.cli).toContain("keyPrefix");
    expect(sources.dashboard).toContain("key.keyPrefix");
    expect(sources.media).not.toContain('fetch("/api/keys"');
    expect(sources.realTest).not.toContain("getApiKeys");
    expect(sources.realTest).toContain("process.env.NV_E2E_KEY");
  });
});
