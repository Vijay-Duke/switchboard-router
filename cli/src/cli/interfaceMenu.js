function buildInterfaceMenuItems({ latestVersion = null, currentVersion = "", trayAvailable = true } = {}) {
  const items = [];

  if (latestVersion) {
    items.push({
      action: "update",
      label: `Update to v${latestVersion} (current: v${currentVersion})`,
      icon: "⬆",
    });
  }

  items.push(
    { action: "web", label: "Web UI (Open in Browser)", icon: "🌐" },
    { action: "terminal", label: "Terminal UI (Interactive CLI)", icon: "💻" },
  );

  items.push({
    action: "hide",
    label: trayAvailable ? "Hide to Tray (Background)" : "Hide to Tray (Retry)",
    icon: "🔔",
  });

  items.push({ action: "exit", label: "Exit", icon: "🚪" });
  return items;
}

async function ensureTrayReady(trayReady, initTrayIcon) {
  if (trayReady) return true;
  return Boolean(await initTrayIcon());
}

module.exports = { buildInterfaceMenuItems, ensureTrayReady };
