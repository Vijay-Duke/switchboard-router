#!/usr/bin/env node
// i18n locale parity check — every advertised translation must match zh-CN.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const literalsDir = join(__dirname, "..", "public", "i18n", "literals");
const configSource = readFileSync(join(__dirname, "..", "src", "i18n", "config.js"), "utf8");
const localesMatch = configSource.match(/export const LOCALES = (\[[\s\S]*?\]);/);
if (!localesMatch) throw new Error("Could not read LOCALES from src/i18n/config.js");
const LOCALES = [...localesMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

const files = readdirSync(literalsDir).filter((file) =>
  file.endsWith(".json") && LOCALES.includes(file.replace(".json", ""))
);
const zhKeys = Object.keys(JSON.parse(readFileSync(join(literalsDir, "zh-CN.json"), "utf8")));
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

if (failed) {
  console.error(`\n\u2716 i18n parity check failed — locales below ${threshold * 100}% coverage`);
  console.error("  Either translate missing keys or remove the locale from LOCALES in src/i18n/config.js");
  process.exit(1);
} else {
  console.log(`\n\u2714 All locales meet ${threshold * 100}% coverage threshold`);
}

function sorted(arr) { return [...arr].sort(); }
