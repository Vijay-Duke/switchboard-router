// @vitest-environment happy-dom
// O17: translate() keeps the source node's surrounding whitespace;
// O18: locale JSON is fetched once per locale across reloads.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { translate, reloadTranslations, getCurrentLocale } from "@/i18n/runtime.js";
import { LOCALE_COOKIE } from "@/i18n/config";

const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ Hello: "你好" }) }));

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock);
  document.cookie = `${LOCALE_COOKIE}=zh-CN`;
  await reloadTranslations();
});

describe("runtime i18n whitespace (O17)", () => {
  it("preserves leading/trailing whitespace around a translated node", () => {
    expect(getCurrentLocale()).toBe("zh-CN");
    expect(translate(" Hello ")).toBe(" 你好 ");
    expect(translate("Hello")).toBe("你好");
    expect(translate("\n  Hello")).toBe("\n  你好");
  });

  it("returns untranslated text unchanged", () => {
    expect(translate(" Nope ")).toBe(" Nope ");
    expect(translate("   ")).toBe("   ");
  });
});

describe("locale JSON cache (O18)", () => {
  it("fetches the locale file once across route-change reloads", async () => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await reloadTranslations();
    await reloadTranslations();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(translate("Hello")).toBe("你好");
  });

  it("refetches when the locale changes", async () => {
    document.cookie = `${LOCALE_COOKIE}=en`;
    await reloadTranslations();
    expect(translate("Hello")).toBe("Hello");
    document.cookie = `${LOCALE_COOKIE}=zh-CN`;
    await reloadTranslations();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(translate("Hello")).toBe("你好");
  });
});
