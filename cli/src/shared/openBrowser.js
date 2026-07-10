const { execFile } = require("child_process");

/**
 * Return a shell-free browser launcher for the current platform.
 * The URL is always passed as one argument, so host text cannot become syntax.
 */
function getBrowserCommand(url, platform = process.platform) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  return null;
}

function openBrowser(url, { platform = process.platform, execFileImpl = execFile, onError } = {}) {
  const launcher = getBrowserCommand(url, platform);
  if (!launcher) {
    if (onError) onError(new Error("Unsupported browser URL or platform"));
    return false;
  }
  execFileImpl(
    launcher.command,
    launcher.args,
    { windowsHide: true },
    (error) => { if (error && onError) onError(error); },
  );
  return true;
}

module.exports = { getBrowserCommand, openBrowser };
