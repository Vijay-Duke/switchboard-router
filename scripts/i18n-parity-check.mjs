#!/usr/bin/env node
// i18n locale parity check — every advertised translation must match zh-CN,
// plus source coverage: nav/crumb literals must exist in zh-CN.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const literalsDir = join(root, "public", "i18n", "literals");
const configSource = readFileSync(join(root, "src", "i18n", "config.js"), "utf8");
const localesMatch = configSource.match(/export const LOCALES = (\[[\s\S]*?\]);/);
if (!localesMatch) throw new Error("Could not read LOCALES from src/i18n/config.js");
const LOCALES = [...localesMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

const files = readdirSync(literalsDir).filter((file) =>
  file.endsWith(".json") && LOCALES.includes(file.replace(".json", ""))
);
const zhData = JSON.parse(readFileSync(join(literalsDir, "zh-CN.json"), "utf8"));
const zhKeys = Object.keys(zhData);
const zhKeySet = new Set(zhKeys);
const threshold = 1; // every advertised locale must contain every reference key

let failed = false;
const results = [];

for (const file of sorted(files)) {
  if (file === "zh-CN.json") continue;
  const locale = file.replace(".json", "");
  const data = JSON.parse(readFileSync(join(literalsDir, file), "utf8"));
  const keys = Object.keys(data);
  const coverage = keys.length / zhKeys.length;
  const missing = zhKeys.filter(k => !(k in data));
  results.push({ locale, coverage, missing: missing.length });

  if (coverage < threshold) {
    console.error(`\u2716 ${locale}: ${keys.length}/${zhKeys.length} keys (${(coverage * 100).toFixed(0)}%) — ${missing.length} missing`);
    failed = true;
  } else {
    console.log(`\u2714 ${locale}: ${keys.length}/${zhKeys.length} keys (${(coverage * 100).toFixed(0)}%)`);
  }
}

// --- source-coverage pass: nav/crumb literals must be translated ---
const sidebarSource = stripComments(readFileSync(join(root, "src", "shared", "components", "Sidebar.js"), "utf8"));
const headerSource = stripComments(readFileSync(join(root, "src", "shared", "components", "Header.js"), "utf8"));
const navLiterals = new Set([
  ...collectLiterals(sidebarSource, /label:\s*"([^"]+)"/g),
  ...collectLiterals(headerSource, /label:\s*"([^"]+)"/g),
  ...collectLiterals(headerSource, /crumb:\s*"([^"]+)"/g),
  ...collectLiterals(headerSource, /section:\s*"([^"]+)"/g),
]);
const missingNav = sorted([...navLiterals].filter((literal) => !zhKeySet.has(literal)));
if (missingNav.length > 0) {
  console.error(`\n\u2716 ${missingNav.length} nav/crumb literal(s) missing from zh-CN.json:`);
  for (const literal of missingNav) console.error(`  - ${literal}`);
  failed = true;
} else {
  console.log(`\n\u2714 All ${navLiterals.size} nav/crumb literals covered in zh-CN.json`);
}

// --- JSX text scan (warning only): literals rendered without a zh-CN key ---
const jsxDirs = [
  join(root, "src", "app", "(dashboard)"),
  join(root, "src", "shared", "components"),
];
const jsxFiles = jsxDirs.flatMap(collectJsFiles);
const jsxLiterals = new Set();
for (const file of jsxFiles) {
  const source = stripComments(readFileSync(file, "utf8"));
  for (const match of source.matchAll(/>\s*([A-Z][^<>{}\n]{3,80}?)\s*</g)) {
    jsxLiterals.add(match[1].trim());
  }
}
const missingJsx = sorted([...jsxLiterals].filter((literal) => !zhKeySet.has(literal)));
if (missingJsx.length > 0) {
  console.warn(`\n\u26A0 ${missingJsx.length} JSX literal(s) missing from zh-CN.json (warning only):`);
  for (const literal of missingJsx.slice(0, 50)) console.warn(`  - ${literal}`);
  if (missingJsx.length > 50) console.warn(`  … and ${missingJsx.length - 50} more`);
}

// --- dead-key scan (warning only): zh-CN keys no longer found in any source ---
const corpus = collectJsFiles(join(root, "src"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const deadKeys = sorted(zhKeys.filter((key) => !corpus.includes(key)));
if (deadKeys.length > 0) {
  console.warn(`\n\u26A0 ${deadKeys.length} zh-CN key(s) not found in any src/ file (warning only):`);
  for (const key of deadKeys.slice(0, 50)) console.warn(`  - ${key}`);
  if (deadKeys.length > 50) console.warn(`  … and ${deadKeys.length - 50} more`);
} else {
  console.log("\n\u2714 No dead keys in zh-CN.json");
}

if (failed) {
  console.error(`\n\u2716 i18n parity check failed — locales below ${threshold * 100}% coverage or nav/crumb literals untranslated`);
  console.error("  Either translate missing keys or remove the locale from LOCALES in src/i18n/config.js");
  process.exit(1);
} else {
  console.log(`\n\u2714 All locales meet ${threshold * 100}% coverage threshold`);
}

function sorted(arr) { return [...arr].sort(); }

function collectLiterals(source, regex) {
  const out = [];
  for (const match of source.matchAll(regex)) out.push(match[1]);
  return out;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
