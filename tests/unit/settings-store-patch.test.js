import { afterEach, describe, expect, it, vi } from "vitest";
import useSettingsStore from "@/store/settingsStore";

afterEach(() => {
  useSettingsStore.setState({ settings: null, loading: false, error: null, lastFetched: 0 });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(response) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response)));
}

describe("settingsStore patchSettings (D14)", () => {
  it("sets error and clears loading on 400, returning null", async () => {
    stubFetch({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "bad patch" }),
    });
    const result = await useSettingsStore.getState().patchSettings({ theme: "nope" });
    expect(result).toBeNull();
    const state = useSettingsStore.getState();
    expect(state.error).toBe("bad patch");
    expect(state.loading).toBe(false);
  });

  it("sets a fallback error when the failure body is empty", async () => {
    stubFetch({
      ok: false,
      status: 500,
      json: () => Promise.reject(new SyntaxError("Unexpected end")),
    });
    const result = await useSettingsStore.getState().patchSettings({ theme: "nope" });
    expect(result).toBeNull();
    expect(useSettingsStore.getState().error).toContain("500");
    expect(useSettingsStore.getState().loading).toBe(false);
  });

  it("sets error on network throw", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    const result = await useSettingsStore.getState().patchSettings({ theme: "x" });
    expect(result).toBeNull();
    expect(useSettingsStore.getState().error).toBe("Failed to save settings");
    expect(useSettingsStore.getState().loading).toBe(false);
  });

  it("clears a stale error on the next successful patch", async () => {
    useSettingsStore.setState({ error: "bad patch" });
    stubFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ theme: "dark" }),
    });
    await useSettingsStore.getState().patchSettings({ theme: "dark" });
    expect(useSettingsStore.getState().error).toBeNull();
  });

  it("stores settings and clears loading on success", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ theme: "dark" }),
    });
    const result = await useSettingsStore.getState().patchSettings({ theme: "dark" });
    expect(result).toEqual({ theme: "dark" });
    expect(useSettingsStore.getState().settings).toEqual({ theme: "dark" });
    expect(useSettingsStore.getState().loading).toBe(false);
  });
});
