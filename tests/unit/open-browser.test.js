import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { getBrowserCommand, openBrowser } = require("../../cli/src/shared/openBrowser.js");

describe("CLI browser launcher", () => {
  it.each([
    ["darwin", "open", []],
    ["linux", "xdg-open", []],
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler"]],
  ])("passes hostile URL text as one argument on %s", (platform, command, prefix) => {
    const url = "http://127.0.0.1:20128/dashboard?q=\";$(touch /tmp/pwned);&x=%PATH%";
    const launcher = getBrowserCommand(url, platform);
    expect(launcher).toEqual({ command, args: [...prefix, url] });

    const execFileImpl = vi.fn((_command, _args, _options, callback) => callback(null));
    expect(openBrowser(url, { platform, execFileImpl })).toBe(true);
    expect(execFileImpl).toHaveBeenCalledWith(
      command,
      [...prefix, url],
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "http://bad\";$(touch /tmp/pwned);&|^%PATH%:20128/dashboard",
  ])(
    "rejects non-web URL %s",
    (url) => {
      expect(getBrowserCommand(url, "darwin")).toBeNull();
    },
  );
});
