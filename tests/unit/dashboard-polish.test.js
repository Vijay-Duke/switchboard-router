import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("dashboard and runtime i18n polish", () => {
  it("guards both active API-key modals against whitespace-only credentials", () => {
    const mainModal = source("src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js");
    const cardModal = source("src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js");

    for (const modal of [mainModal, cardModal]) {
      expect(modal).toContain("formData.name.trim().length > 0");
      expect(modal).toContain("formData.apiKey.trim().length > 0");
      expect(modal).toContain('autoComplete="off"');
      expect(modal).toContain("min={1}");
    }
    expect(mainModal).toContain("if (!apiKey) {");
  });

  it("translates marked attributes and option labels using the supported zh-CN map", () => {
    const runtime = source("src/i18n/runtime.js");
    const languageSwitcher = source("src/shared/components/LanguageSwitcher.js");
    const zh = JSON.parse(source("public/i18n/literals/zh-CN.json"));

    expect(runtime).toContain('"data-i18n-placeholder": "placeholder"');
    expect(runtime).toContain('const AUTO_TRANSLATABLE_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"]');
    expect(runtime).toContain('attributes: true');
    expect(runtime).toContain('element.querySelectorAll?.("*")');
    expect(runtime).not.toContain('"select", "datalist", "optgroup"');
    expect(languageSwitcher).toContain('data-i18n="Select Language"');
    expect(zh["Select Language"]).toBe("选择语言");
    expect(zh["Auto (by priority)"]).toBe("自动（按优先级）");
    expect(zh["JSON (Base64)"]).toBe("JSON（Base64）");
  });

  it("keeps only locale files advertised by runtime config", () => {
    const files = fs.readdirSync(path.join(repoRoot, "public/i18n/literals"))
      .filter((file) => file.endsWith(".json"))
      .sort();
    expect(files).toEqual(["zh-CN.json"]);
  });

  it("redacts provider credentials before server-component props cross to the browser", () => {
    const loaders = source("src/lib/dashboard/loaders.js");

    expect(loaders).toContain('import { redactSecrets } from "@/models"');
    expect(loaders).toContain("connections: (connections || []).map(redactSecrets)");
  });

  it("uses stable labels for unnamed destructive confirmations", () => {
    const providerPage = source("src/app/(dashboard)/dashboard/providers/[id]/page.js");
    const endpointPage = source("src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js");
    const usagePage = source("src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js");
    const headerMenu = source("src/shared/components/HeaderMenu.js");
    const profilePage = source("src/app/(dashboard)/dashboard/profile/ProfilePageClient.js");

    expect(providerPage).toContain("connection?.name?.trim() || connection?.email?.trim() || id");
    expect(endpointPage).toContain("key.name?.trim() || key.id");
    expect(usagePage).toContain("getConnectionLabel(connection || {}) || id");
    expect(headerMenu).toContain('title="Shutdown"');
    expect(headerMenu).toContain('confirmText="Shutdown"');
    expect(profilePage).toContain('title="Shutdown"');
    expect(profilePage).toContain('confirmText="Shutdown"');
  });
});
