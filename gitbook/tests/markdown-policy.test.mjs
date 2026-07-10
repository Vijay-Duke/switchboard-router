import test from "node:test";
import assert from "node:assert/strict";

import { findUnsupportedHtml } from "../scripts/check-markdown.mjs";

test("reports raw HTML with its source line", () => {
  const markdown = [
    "# Switchboard",
    "",
    '<div align="center">',
    "  <sub>Built with care</sub>",
    "</div>"
  ].join("\n");

  assert.deepEqual(findUnsupportedHtml(markdown), [
    { line: 3, source: '<div align="center">' },
    { line: 4, source: "  <sub>Built with care</sub>" },
    { line: 5, source: "</div>" }
  ]);
});

test("allows HTML examples inside fenced and inline code", () => {
  const markdown = [
    "Use `<sub>text</sub>` only as an example.",
    "",
    "```html",
    '<div align="center">example</div>',
    "```"
  ].join("\n");

  assert.deepEqual(findUnsupportedHtml(markdown), []);
});

test("reports HTML comments and multiline tag starts", () => {
  const markdown = [
    "<!-- hidden note -->",
    "<div",
    '  class="footer">',
    "content",
    "</div>"
  ].join("\n");

  assert.deepEqual(findUnsupportedHtml(markdown), [
    { line: 1, source: "<!-- hidden note -->" },
    { line: 2, source: "<div" },
    { line: 5, source: "</div>" }
  ]);
});

test("reports declarations, processing instructions, and CDATA", () => {
  const markdown = [
    "<!DOCTYPE html>",
    '<?render mode="docs"?>',
    "<![CDATA[raw content]]>"
  ].join("\n");

  assert.deepEqual(findUnsupportedHtml(markdown), [
    { line: 1, source: "<!DOCTYPE html>" },
    { line: 2, source: '<?render mode="docs"?>' },
    { line: 3, source: "<![CDATA[raw content]]>" }
  ]);
});
