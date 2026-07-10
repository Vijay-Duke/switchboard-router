import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTENT_ROOT = fileURLToPath(new URL("../content/", import.meta.url));
const HTML_START = /<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?[A-Za-z][A-Za-z0-9-]*(?=\s|\/?>|$)/;

function stripInlineCode(line) {
  let result = "";
  let index = 0;

  while (index < line.length) {
    if (line[index] !== "`") {
      result += line[index];
      index += 1;
      continue;
    }

    let runEnd = index;
    while (line[runEnd] === "`") runEnd += 1;
    const delimiter = line.slice(index, runEnd);
    const closingIndex = line.indexOf(delimiter, runEnd);

    if (closingIndex === -1) {
      result += delimiter;
      index = runEnd;
      continue;
    }

    result += " ".repeat(closingIndex + delimiter.length - index);
    index = closingIndex + delimiter.length;
  }

  return result;
}

export function findUnsupportedHtml(markdown) {
  const findings = [];
  let fence = null;

  markdown.split(/\r?\n/).forEach((line, index) => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      return;
    }

    if (fence || /^(?: {4}|\t)/.test(line)) return;

    if (HTML_START.test(stripInlineCode(line))) {
      findings.push({ line: index + 1, source: line });
    }
  });

  return findings;
}

function collectMarkdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectMarkdownFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
    })
    .sort();
}

export function checkMarkdownTree(contentRoot = CONTENT_ROOT) {
  return collectMarkdownFiles(contentRoot).flatMap(filePath =>
    findUnsupportedHtml(fs.readFileSync(filePath, "utf8")).map(finding => ({
      ...finding,
      filePath
    }))
  );
}

function main() {
  const findings = checkMarkdownTree();
  if (findings.length === 0) {
    console.log("Markdown policy check passed: no unsupported raw HTML found.");
    return;
  }

  console.error("Unsupported raw HTML found in GitBook content.");
  console.error("Use native Markdown, or wrap HTML examples in backticks or a fenced code block.\n");
  findings.forEach(({ filePath, line, source }) => {
    console.error(`${path.relative(process.cwd(), filePath)}:${line}: ${source.trim()}`);
  });
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
