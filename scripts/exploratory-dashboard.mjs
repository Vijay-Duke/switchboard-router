#!/usr/bin/env node
/**
 * Charter-based exploratory dashboard pass (headless Chromium).
 * Screenshots → /cursor/stores/self/media/exploratory-2026-10-23/
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const BASE = process.env.SWITCHBOARD_BASE || "http://127.0.0.1:20128";
const MEDIA = process.env.EXPLORATORY_MEDIA_DIR || "/cursor/stores/self/media/exploratory-2026-10-23";
const findings = [];

fs.mkdirSync(MEDIA, { recursive: true });

async function shot(page, name) {
  const file = path.join(MEDIA, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function visit(page, route, name) {
  const url = `${BASE}${route}`;
  const res = await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
  const status = res?.status() ?? 0;
  if (status >= 500) {
    findings.push({ severity: "high", area: route, issue: `HTTP ${status} on navigation`, repro: `Open ${url}` });
  }
  await shot(page, name);
  return status;
}

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const charters = [
  { route: "/dashboard", name: "01-dashboard-home" },
  { route: "/dashboard/endpoint", name: "02-endpoint-keys-budget" },
  { route: "/dashboard/usage?tab=overview", name: "03-usage-overview" },
  { route: "/dashboard/usage?tab=logs", name: "04-usage-logs" },
  { route: "/dashboard/usage?tab=details", name: "05-usage-details" },
  { route: "/dashboard/providers", name: "06-providers" },
  { route: "/dashboard/cli-tools", name: "07-cli-tools" },
  { route: "/dashboard/profile", name: "08-profile-observability" },
  { route: "/dashboard/quota", name: "09-quota" },
  { route: "/dashboard/token-saver", name: "10-token-saver" },
];

const started = Date.now();
for (const c of charters) {
  await visit(page, c.route, c.name);
}

// Endpoint: open key policy modal if a key row exists
await page.goto(`${BASE}/dashboard/endpoint`, { waitUntil: "networkidle2" });
const editBtn = await page.evaluateHandle(() => {
  const buttons = [...document.querySelectorAll("button")];
  return buttons.find((b) => /policy|edit key/i.test(b.textContent || "")) || null;
});
const editEl = editBtn.asElement();
if (editEl) {
  await editEl.click();
  await new Promise((r) => setTimeout(r, 500));
  await shot(page, "02b-key-policy-modal");
} else {
  findings.push({ severity: "low", area: "endpoint", issue: "No edit policy control found (empty keys?)", repro: "Open endpoint with keys" });
}

// Logs API smoke
const logsRes = await fetch(`${BASE}/api/usage/request-logs?format=records&limit=5`);
if (!logsRes.ok) {
  findings.push({ severity: "medium", area: "logs", issue: `request-logs returned ${logsRes.status}`, repro: "GET /api/usage/request-logs?format=records" });
} else {
  const body = await logsRes.json();
  if (!Array.isArray(body)) {
    findings.push({ severity: "medium", area: "logs", issue: "records format is not an array", repro: "GET format=records" });
  }
}

// Keys list includes spentUsd refresh
const keysRes = await fetch(`${BASE}/api/keys`);
if (keysRes.ok) {
  const { keys } = await keysRes.json();
  if (Array.isArray(keys) && keys[0] && typeof keys[0].spentUsd !== "number") {
    findings.push({ severity: "medium", area: "budget", issue: "API keys missing numeric spentUsd", repro: "GET /api/keys" });
  }
}

// Pi manual configs API
const piRes = await fetch(`${BASE}/api/cli-tools/pi-settings/manual-configs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    baseUrl: `${BASE}/v1`,
    apiKey: "sk_switchboard",
    models: ["muse/muse-wonder-1.0-max"],
    defaultModel: "muse/muse-wonder-1.0-max",
    pickerLabels: {},
  }),
});
if (!piRes.ok) {
  findings.push({ severity: "medium", area: "cli-tools", issue: `Pi manual-configs ${piRes.status}`, repro: "POST manual-configs" });
} else {
  const data = await piRes.json();
  const yml = data.configs?.find((c) => c.filename?.includes("models.yml"));
  if (!yml?.content?.includes("thinkingLevelMap")) {
    findings.push({ severity: "low", area: "cli-tools", issue: "Pi manual yml missing thinkingLevelMap for muse", repro: "POST manual-configs muse model" });
  }
}

await browser.close();

const report = {
  durationMinutes: Math.round((Date.now() - started) / 60000),
  base: BASE,
  charters: charters.map((c) => c.route),
  screenshotsDir: MEDIA,
  findings,
  fixedInPr: [
    "Health readiness via background heartbeat (non-blocking GET)",
    "h2c body cap + read timeout",
    "SSE reassembly byte cap",
    "Structured usage log records for dashboard",
    "API keys list refreshes spentUsd for spend ceiling UI",
    "Pi manual configs via buildPiManualConfigFiles + API",
    "Key policy optionalNumber rejects NaN",
  ],
};
console.log(JSON.stringify(report, null, 2));
