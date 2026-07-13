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

  if (trayAvailable) {
    items.push({ action: "hide", label: "Hide to Tray (Background)", icon: "🔔" });
  }

  items.push({ action: "exit", label: "Exit", icon: "🚪" });
  return items;
}

module.exports = { buildInterfaceMenuItems };
