import { useNotificationStore } from "@/store/notificationStore";

const DEDUPE_WINDOW_MS = 5000;
const recentMessages = new Map();

function printable(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Surface client failures through the dashboard notification system.
 * Repeated stream/poll errors are deduplicated so one fault cannot create a
 * toast storm. This intentionally replaces ad-hoc browser console logging.
 */
export function reportClientError(...values) {
  const message = values.map(printable).filter(Boolean).join(" ").trim()
    || "The operation failed";
  const now = Date.now();
  const lastSeen = recentMessages.get(message) || 0;
  if (now - lastSeen < DEDUPE_WINDOW_MS) return;
  recentMessages.set(message, now);
  for (const [entry, timestamp] of recentMessages) {
    if (now - timestamp > DEDUPE_WINDOW_MS) recentMessages.delete(entry);
  }
  useNotificationStore.getState().error(message);
}
