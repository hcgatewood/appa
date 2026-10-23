// End-to-end tests for appa's server. They start the appa CLI on a free port against a tmp directory of fixtures,
// then check routing, the directory index, the directory-traversal guard, and the page assets appa serves itself.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");

let fixturesDir;
let appa;
let port;
let baseUrl;

before(async () => {
  fixturesDir = await mkdtemp(join(tmpdir(), "appa-test-"));
  await writeFile(
    join(fixturesDir, "notes.md"),
    "# Notes\n\n```mermaid\na --> b\n```\n",
  );
  await writeFile(join(fixturesDir, "my notes (draft).md"), "# Draft\n");

  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const cli = join(repoDir, "bin", "appa.js");
  appa = spawn(
    process.execPath,
    [cli, "start", "--port", String(port), fixturesDir],
    { stdio: "ignore" },
  );
  await waitForServer(baseUrl);
});

after(async () => {
  appa.kill();
  await rm(fixturesDir, { recursive: true, force: true });
});

test("serves a Markdown file at its path, with or without .md", async () => {
  for (const path of ["/notes.md", "/notes"]) {
    const res = await fetch(baseUrl + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<h1[^>]*>Notes<\/h1>/, path);
  }
});

test("links each file from the index, with its name escaped for URLs", async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();
  assert.ok(html.includes('href="notes.md"'));
  assert.ok(html.includes('href="my%20notes%20%28draft%29.md"'));
});

test("refuses paths that climb out of the served directory", async () => {
  assert.equal(await rawStatus("/../secret.md"), 403);
  assert.notEqual(await rawStatus("/_appa/katex/../../../package.json"), 200);
});

test("loads every stylesheet and script from appa itself", async () => {
  const html = await (await fetch(`${baseUrl}/notes.md`)).text();
  const assetPaths = [
    ...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g),
    ...html.matchAll(/<script src="([^"]+)"/g),
    ...html.matchAll(/script\.src = "([^"]+)"/g), // Mermaid, loaded on pages with a diagram
  ].map((match) => match[1]);

  assert.ok(assetPaths.length > 0, "found no assets in the page");
  for (const path of assetPaths) {
    assert.ok(path.startsWith("/"), `not served by appa: ${path}`);
    const res = await fetch(baseUrl + path);
    assert.equal(res.status, 200, path);
    assert.doesNotMatch(res.headers.get("content-type"), /html/, path);
  }
});

test("serves the KaTeX fonts its stylesheet points to", async () => {
  const css = await (
    await fetch(`${baseUrl}/_appa/katex/katex.min.css`)
  ).text();
  const font = css.match(/url\((fonts\/[^)]+\.woff2)\)/)?.[1];
  assert.ok(font, "found no woff2 font in the KaTeX stylesheet");

  const res = await fetch(`${baseUrl}/_appa/katex/${font}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /font/);
});

test("serves the Mermaid build from the installed dev dependency", async () => {
  // Catches a stale copy, e.g. after a Mermaid upgrade without rerunning `npm install`
  const res = await fetch(`${baseUrl}/_appa/mermaid/mermaid.min.js`);
  const installed = await readFile(
    join(repoDir, "node_modules", "mermaid", "dist", "mermaid.min.js"),
  );
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(installed));
});

// freePort returns a TCP port that's free right now, by letting the OS pick one and releasing it.
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// waitForServer resolves once url answers, and fails after 10 seconds.
async function waitForServer(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`appa didn't start at ${url}`);
}

// rawStatus returns the status code for path, sent exactly as written. fetch would resolve the ".." segments
// before sending, so these requests use node:http, which doesn't.
function rawStatus(path) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
      .on("error", reject)
      .end();
  });
}
