// Tests for appa's Markdown rendering: what the sanitizer keeps, and how Mermaid and other code blocks come out.

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMd } from "../src/app.js";

const pngDataUri = "data:image/png;base64,iVBORw0KGgo=";

test("keeps embedded data: images, in Markdown and in raw HTML", () => {
  const html = renderMd(
    `![md](${pngDataUri})\n\n<img alt="raw" src="${pngDataUri}">\n`,
  );
  assert.equal(html.split(`src="${pngDataUri}"`).length - 1, 2);
});

test("strips data: links and javascript: images", () => {
  const html = renderMd(
    '<a href="data:text/html,hi">link</a>\n\n<img alt="js" src="javascript:alert(1)">\n',
  );
  assert.doesNotMatch(html, /href="data:/);
  assert.doesNotMatch(html, /javascript:/);
});

test("keeps sms: and imessage: links", () => {
  const html = renderMd(
    "[text](sms:+15555550100) and [chat](imessage:someone@example.com)\n",
  );
  assert.match(html, /href="sms:\+15555550100"/);
  assert.match(html, /href="imessage:someone@example.com"/);
});

test("renders mermaid blocks as <pre class=mermaid>, with the source escaped", () => {
  const html = renderMd(
    '```mermaid\nflowchart TD\n  a["<script>x</script>"] --> b\n```\n',
  );
  assert.ok(html.includes('<pre class="mermaid">flowchart TD'));
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(html.includes("--&gt; b"));
  assert.doesNotMatch(html, /<script>/);
});

test("keeps mermaid blocks away from highlight.js", (t) => {
  // highlight.js logs an error for every block in a language it doesn't know
  const error = t.mock.method(console, "error", () => {});
  const warn = t.mock.method(console, "warn", () => {});

  const html = renderMd("```mermaid\na --> b\n```\n");

  assert.doesNotMatch(html, /hljs/);
  assert.equal(error.mock.callCount() + warn.mock.callCount(), 0);
});

test("still highlights other code blocks", () => {
  const html = renderMd("```js\nconst x = 1;\n```\n");
  assert.match(html, /<code class="hljs language-js">/);
});
