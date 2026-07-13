import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const readProjectFile = (relativePath) =>
  fs.readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");

test("docs shell contains only Switchboard branding and links to the local app", () => {
  const header = readProjectFile("components/DocsHeader.js");
  const config = readProjectFile("constants/docsConfig.js");

  assert.doesNotMatch(header, />\s*9\s*</, "legacy 9router mark must not appear in the header");
  assert.match(header, /\/favicon\.svg/);
  assert.doesNotMatch(header, /GitBranch/);
  assert.match(config, /appUrl:\s*"http:\/\/127\.0\.0\.1:20128\/dashboard"/);
});

test("docs use the canonical Switchboard icon without diverging", () => {
  const docsIcon = readProjectFile("public/favicon.svg");
  const appIcon = fs.readFileSync(
    fileURLToPath(new URL("../../public/favicon.svg", import.meta.url)),
    "utf8"
  );

  assert.equal(docsIcon, appIcon);
});

test("Markdown output keeps the class targeted by the typography stylesheet", () => {
  const renderer = readProjectFile("utils/markdown.js");

  assert.match(renderer, /<div className="markdown-content">[\s\S]*<ReactMarkdown/);
  assert.doesNotMatch(renderer, /<ReactMarkdown[\s\S]*className="markdown-content"/);
});

test("docs navigation covers the current dashboard tools", () => {
  const config = readProjectFile("constants/docsConfig.js");

  for (const slug of [
    "using/token-saver",
    "using/media",
    "using/skills-agent-library",
  ]) {
    assert.match(config, new RegExp(`slug:\\s*"${slug}"`), `missing navigation entry for ${slug}`);
  }
});
