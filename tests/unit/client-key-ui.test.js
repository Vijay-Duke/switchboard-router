import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const page = fs.readFileSync(path.join(ROOT, "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js"), "utf8");
const modalPath = path.join(ROOT, "src/app/(dashboard)/dashboard/endpoint/components/KeyPolicyModal.js");

describe("client key policy UI contract", () => {
  it("wires an edit modal to the exact bounded policy PUT fields", () => {
    expect(fs.existsSync(modalPath)).toBe(true);
    const modal = fs.readFileSync(modalPath, "utf8");
    for (const field of [
      "name", "isActive", "allowedModels", "allowedCombos", "expiresAt",
      "rateLimitPerMinute", "concurrencyLimit", "spendLimitUsd",
    ]) {
      expect(modal).toContain(field);
    }
    expect(modal).toContain("spentUsd");
    expect(modal).toContain('type="datetime-local"');
    expect(modal).toContain('type="number"');
    expect(page).toContain("<KeyPolicyModal");
    expect(page).toContain('method: "PUT"');
    expect(page).toContain("queryKeys.endpoint.keys()");
  });

  it("shows only safe prefixes for listed keys while retaining one-time creation copy", () => {
    expect(page).toContain("key.keyPrefix");
    expect(page).not.toContain("visibleKeys");
    expect(page).not.toContain("toggleKeyVisibility");
    expect(page).not.toContain("maskKey");
    expect(page).not.toContain("copy(key.key");
    expect(page).toContain('copy(createdKey, "created_key")');
    expect(page).toContain("setCreatedKey(data.key || null)");
  });

  it("renders current spend and concise policy summaries", () => {
    expect(page).toContain("spentUsd");
    expect(page).toContain("allowedModels");
    expect(page).toContain("rateLimitPerMinute");
    expect(page).toContain("concurrencyLimit");
    expect(page).toContain("spendLimitUsd");
  });

  it("shows a safe rotation-required warning without verifier metadata", () => {
    expect(page).toContain("rotationRequired");
    expect(page).toContain("Rotation required");
    expect(page).not.toContain("lookupDigest");
  });
});
