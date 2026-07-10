import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const rootPackage = read("package.json");
const expected = process.argv[2] || rootPackage.version;
const versions = [
  ["package.json", rootPackage.version],
  ["package-lock.json", read("package-lock.json").packages?.[""]?.version],
  ["cli/package.json", read("cli/package.json").version],
  ["cli/package-lock.json", read("cli/package-lock.json").packages?.[""]?.version],
];

const mismatches = versions.filter(([, version]) => version !== expected);
if (mismatches.length) {
  for (const [file, version] of mismatches) {
    console.error(`${file}: expected ${expected}, found ${version || "missing"}`);
  }
  process.exit(1);
}
console.log(`Release version ${expected} is committed consistently in all manifests and locks.`);
