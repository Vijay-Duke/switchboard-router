// Gate: compare current test results with the known-fails baseline.
// Pass when no baseline-passing test starts failing now. New tests are allowed.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import { relative } from "path";
import { fileURLToPath } from "url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => `${relative(repoRoot, f.name).replaceAll("\\", "/")} :: ${a.fullName}`)
);

// A suite that fails to run (module resolution, syntax error, setup crash) reports
// no assertionResults, so counting only failed assertions turned a broken build
// into a green "no regression" — while vitest itself exited 1.
const failedSuites = r.testResults
  .filter(f => f.status === "failed" && !f.assertionResults.some(a => a.status === "failed"))
  .map(f => `${relative(repoRoot, f.name).replaceAll("\\", "/")} :: <suite failed to run>`);

// Regression = fails now but is not in the known-fails baseline.
const regressions = [...nowFails, ...failedSuites].filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length + failedSuites.length}, baseline known=${knownFails.size}, all known)`);
