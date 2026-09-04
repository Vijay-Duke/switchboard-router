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

/**
 * Map a selectMenu() index to a menu action. ESC / non-TTY resolves -1 and
 * out-of-range indexes are treated as "back" (re-show the menu) — never as
 * "exit", so dismissing the menu cannot shut down a healthy gateway.
 */
function mapInterfaceSelection(menuItems, selected) {
  if (!Array.isArray(menuItems)) return "back";
  if (!Number.isInteger(selected) || selected < 0 || selected >= menuItems.length) return "back";
  return menuItems[selected]?.action || "back";
}

module.exports = { buildInterfaceMenuItems, ensureTrayReady, mapInterfaceSelection };
