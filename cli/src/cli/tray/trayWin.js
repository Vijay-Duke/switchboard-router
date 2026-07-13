const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

// PowerShell-based tray for Windows (AV-safe, zero binary deps)

let psProcess = null;
let clickHandler = null;

/**
 * Send JSON command to PowerShell tray process via stdin
 */
function sendCommand(cmd) {
  if (psProcess && psProcess.stdin.writable) {
    psProcess.stdin.write(`${JSON.stringify(cmd)}\n`, "utf8");
  }
}

/**
 * Initialize Windows tray using PowerShell NotifyIcon
 * @param {Object} options - { iconPath, tooltip, items, onClick }
 *   items: [{ title, enabled }]
 * @returns {Object|null} controller with sendAction/kill
 */
function initWinTray(options) {
  const { iconPath, tooltip, items, onClick } = options;
  clickHandler = onClick;

  const scriptPath = path.join(__dirname, "tray.ps1");

  try {
    psProcess = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-InputFormat", "Text",
        "-OutputFormat", "Text",
        "-File", scriptPath,
        "-IconPath", iconPath,
        "-Tooltip", tooltip
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    return null;
  }

  const rl = readline.createInterface({ input: psProcess.stdout });
  rl.on("line", (line) => {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "click" && clickHandler) {
        clickHandler(evt.index);
      }
    } catch (e) {}
  });

  psProcess.on("error", () => {});
  psProcess.on("exit", () => { psProcess = null; });
  psProcess.stderr.on("data", () => {});

  // Send initial menu items
  items.forEach((item, index) => {
    sendCommand({ action: "add-item", index, title: item.title, enabled: item.enabled });
  });

  return {
    updateItem(index, title, enabled) {
      sendCommand({ action: "update-item", index, title, enabled });
    },
    setTooltip(text) {
      sendCommand({ action: "set-tooltip", text });
    },
    kill() {
      const target = psProcess;
      if (!target) return Promise.resolve();
      return new Promise((resolve) => {
        let done = false;
        let fallback;
        const finish = () => {
          if (done) return;
          done = true;
          if (fallback) clearTimeout(fallback);
          target.removeListener("exit", finish);
          resolve();
        };
        target.once("exit", finish);
        try { sendCommand({ action: "kill" }); } catch (e) {}
        fallback = setTimeout(() => {
          if (psProcess === target && !target.killed) {
            try { target.kill(); } catch (e) {}
          }
          if (psProcess === target) psProcess = null;
          finish();
        }, 1000);
      });
    }
  };
}

module.exports = { initWinTray };
