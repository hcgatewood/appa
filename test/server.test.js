// End-to-end tests for appa's server. They start the appa CLI on a free port against a tmp directory of fixtures,
// then check routing, the directory index, the directory-traversal guard, and the page assets appa serves itself.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");

let fixturesDir;
let neighborDir; // beside fixturesDir, with a name that starts the same way, e.g. appa-test-x1y2 and appa-test-x1y2-old
let appa;
let port;
let baseUrl;

before(async () => {
  // Use the real path, as process.cwd() reports it. macOS's tmpdir sits behind a symlink (/var -> /private/var), and
  // chokidar catches some changes through the symlink that it misses under the real path.
  fixturesDir = await realpath(await mkdtemp(join(tmpdir(), "appa-test-")));
  await writeFile(
    join(fixturesDir, "notes.md"),
    "# Notes\n\n```mermaid\na --> b\n```\n",
  );
  await writeFile(join(fixturesDir, "my notes (draft).md"), "# Draft\n");
  await writeFile(join(fixturesDir, "Tom & Jerry.md"), "# Tom\n");
  await writeFile(join(fixturesDir, "..dots.md"), "# Dots\n");
  await mkdir(join(fixturesDir, "sub"));
  await writeFile(join(fixturesDir, "sub", "inner.md"), "# Inner\n");
  await mkdir(join(fixturesDir, "socket.io"));
  await writeFile(
    join(fixturesDir, "socket.io", "notes.md"),
    "# Socket notes\n",
  );
  await writeFile(
    join(fixturesDir, "page.html"),
    "<html><body><h1>Page</h1></body></html>\n",
  );
  await writeFile(join(fixturesDir, "fragment.html"), "<p>No body tag</p>\n");
  // "İ" lowercases to two characters, so it shifts any index found in a lowercased copy of the page
  await writeFile(
    join(fixturesDir, "turkish.html"),
    "<html><BODY><p>İstanbul</p></BODY></html>\n",
  );
  await writeFile(join(fixturesDir, "style.css"), "h1 {}\n");
  await writeFile(join(fixturesDir, "app.js"), "// script\n");
  await writeFile(join(fixturesDir, "notes.txt"), "not a page\n");

  neighborDir = `${fixturesDir}-old`;
  await mkdir(neighborDir);
  await writeFile(join(neighborDir, "secret.md"), "NEIGHBOR-SECRET\n");

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
  await rm(neighborDir, { recursive: true, force: true });
});

test("serves a Markdown file at its path, with or without .md", async () => {
  for (const path of ["/notes.md", "/notes"]) {
    const res = await fetch(baseUrl + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<h1[^>]*>Notes<\/h1>/, path);
  }
});

test("serves a docs folder named socket.io, since live reload lives under /_appa/", async () => {
  const res = await fetch(`${baseUrl}/socket.io/notes.md`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1[^>]*>Socket notes<\/h1>/);
});

test("links each file from the index, with its name escaped for URLs", async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();
  assert.ok(html.includes('href="notes.md"'));
  assert.ok(html.includes('href="my%20notes%20%28draft%29.md"'));
});

test("lists HTML pages in the index alongside Markdown", async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();
  assert.ok(html.includes('href="page.html"'));
  assert.ok(!html.includes('href="style.css"'));
});

test("lists the other pages when a folder below the index can't be read", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can read any folder");
    return;
  }
  const locked = join(fixturesDir, "locked");
  await mkdir(locked);
  await writeFile(join(locked, "hidden.md"), "# Hidden\n");
  await chmod(locked, 0o000);
  try {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('href="notes.md"'));
    assert.ok(!html.includes("hidden.md"));
  } finally {
    await chmod(locked, 0o755);
    await rm(locked, { recursive: true });
  }
});

test("adds live reload to an HTML page, before its </body>", async () => {
  const res = await fetch(`${baseUrl}/page.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /html/);

  const html = await res.text();
  const script = html.indexOf('<script src="/_appa/socket.io/socket.io.js">');
  assert.ok(html.includes("<h1>Page</h1>"));
  assert.ok(
    script > html.indexOf("<h1>Page</h1>"),
    "script isn't after the content",
  );
  assert.ok(
    script < html.lastIndexOf("</body>"),
    "script isn't before </body>",
  );
});

test("adds live reload before </body> whatever its case or the text before it", async () => {
  const html = await (await fetch(`${baseUrl}/turkish.html`)).text();
  assert.ok(html.includes("<p>İstanbul</p>"));
  assert.match(html, /<\/script>\n<\/BODY><\/html>\n$/);
});

test("adds live reload to an HTML page with no </body>", async () => {
  const html = await (await fetch(`${baseUrl}/fragment.html`)).text();
  assert.ok(html.startsWith("<p>No body tag</p>"));
  assert.ok(html.includes('<script src="/_appa/socket.io/socket.io.js">'));
});

test("points each page's live-reload client at the socket appa listens on", async () => {
  const client = await fetch(`${baseUrl}/_appa/live_reload.js`);
  assert.equal(client.status, 200);
  assert.match(client.headers.get("content-type"), /javascript/);
  for (const page of ["/notes.md", "/page.html"]) {
    const html = await (await fetch(baseUrl + page)).text();
    assert.ok(html.includes('<script src="/_appa/live_reload.js"'), page);
    const path = html.match(/data-socket-path="([^"]+)"/)?.[1];
    assert.ok(path, `found no socket path in ${page}`);
    assert.equal(
      await rawStatus(`${path}/?EIO=4&transport=polling`),
      200,
      page,
    );
  }
});

test("reloads an HTML page when it, or the CSS or JS beside it, changes", async () => {
  for (const file of ["page.html", "style.css", "app.js"]) {
    const replies = await socketReplies("watch", "/page.html", {
      change: () => appendFile(join(fixturesDir, file), "\n"),
    });
    assert.ok(
      replies.some(([event]) => event === "file_updated"),
      file,
    );
  }
});

test("doesn't reload an HTML page for other files beside it", async () => {
  const replies = await socketReplies("watch", "/page.html", {
    change: () => appendFile(join(fixturesDir, "notes.txt"), "\n"),
  });
  assert.deepEqual(replies, []);
});

test("reloads a Markdown page when its file changes", async () => {
  const replies = await socketReplies("watch", "/notes.md", {
    change: () => appendFile(join(fixturesDir, "notes.md"), "\n"),
  });
  assert.ok(replies.some(([event]) => event === "file_updated"));
});

test("reloads a Markdown page only for its own file", async () => {
  const replies = await socketReplies("watch", "/notes.md", {
    change: () => appendFile(join(fixturesDir, "style.css"), "\n"),
  });
  assert.deepEqual(replies, []);
});

test("reloads a directory's index when a page anywhere below it is added or removed", async () => {
  const added = join(fixturesDir, "sub", "added.md");
  for (const change of [() => writeFile(added, "# Added\n"), () => rm(added)]) {
    const replies = await socketReplies("watch", "/", { change });
    assert.deepEqual(replies, [["file_updated"]]);
  }
});

test("doesn't reload a directory's index for page edits or other files", async () => {
  const other = join(fixturesDir, "sub", "other.txt");
  const replies = await socketReplies("watch", "/sub", {
    change: async () => {
      await appendFile(join(fixturesDir, "sub", "inner.md"), "\n");
      await writeFile(other, "not a page\n");
    },
  });
  await rm(other);
  assert.deepEqual(replies, []);
});

test("sends one reload for a burst of changes", async () => {
  const pages = ["apple", "banana", "cherry", "donut", "egg"].map((name) =>
    join(fixturesDir, "sub", `${name}.md`),
  );
  const replies = await socketReplies("watch", "/sub", {
    change: () =>
      Promise.all(pages.map((page) => writeFile(page, "# Burst\n"))),
  });
  await Promise.all(pages.map((page) => rm(page)));
  assert.deepEqual(replies, [["file_updated"]]);
});

test("reloads each of several open pages only for its own changes", async () => {
  // Like open tabs: two on the same page, then another page, an HTML page, and the index
  const urls = [
    "/notes.md",
    "/notes.md",
    "/Tom%20%26%20Jerry.md",
    "/page.html",
    "/",
  ];
  const tabs = urls.map((url) => openSocket("watch", url));
  const notes = join(fixturesDir, "notes.md");
  const added = join(fixturesDir, "sub", "tabs.md");
  // Each step's change, and how many reloads each tab should get from it
  const steps = [
    ["edit notes.md", () => appendFile(notes, "\n"), [1, 1, 0, 0, 0]],
    [
      "edit style.css",
      () => appendFile(join(fixturesDir, "style.css"), "\n"),
      [0, 0, 0, 1, 0],
    ],
    ["add a page", () => writeFile(added, "# Tabs\n"), [0, 0, 0, 0, 1]],
    ["remove a page", () => rm(added), [0, 0, 0, 0, 1]],
    [
      "close one notes.md tab, then edit notes.md",
      () => {
        tabs[0].close();
        return appendFile(notes, "\n");
      },
      [0, 1, 0, 0, 0],
    ],
  ];

  try {
    await sleep(500); // let the watchers start
    assert.ok(
      tabs.every((tab) => tab.joined),
      "a socket.io handshake didn't complete",
    );
    for (const [label, change, want] of steps) {
      for (const tab of tabs) tab.replies.length = 0;
      await change();
      await sleep(1000);
      assert.deepEqual(
        tabs.map((tab) => tab.replies.length),
        want,
        label,
      );
    }
  } finally {
    for (const tab of tabs) tab.close();
    await rm(added, { force: true });
  }
});

test("finds the file to watch from a page's URL, the way the page request did", async () => {
  // e.g. a name URLs escape, and a URL that leaves off .md
  for (const [url, file] of [
    ["/Tom%20%26%20Jerry.md", "Tom & Jerry.md"],
    ["/notes", "notes.md"],
  ]) {
    const replies = await socketReplies("watch", url, {
      change: () => appendFile(join(fixturesDir, file), "\n"),
    });
    assert.ok(
      replies.some(([event]) => event === "file_updated"),
      url,
    );
  }
});

test("doesn't watch files outside the served directory", async () => {
  const neighbor = basename(neighborDir);
  for (const url of [
    `/../${neighbor}/secret.md`,
    `/%2E%2E/${neighbor}/secret.md`,
    `/..%2F${neighbor}%2Fsecret.md`,
  ]) {
    const replies = await socketReplies("watch", url, {
      change: () => appendFile(join(neighborDir, "secret.md"), "\n"),
    });
    assert.deepEqual(replies, [], url);
  }
});

test("survives watch messages that name no page", async () => {
  // e.g. a malformed escape, a missing file, and a message that isn't a string
  for (const payload of ["/%E0%A4%A", "/missing.md", 42]) {
    await socketReplies("watch", payload, { waitMs: 200 });
  }
  assert.equal((await fetch(`${baseUrl}/notes.md`)).status, 200);
});

test("writes no file name into a page's scripts", async () => {
  for (const [url, name] of [
    ["/Tom%20%26%20Jerry.md", "Jerry"],
    ["/page.html", "page.html"],
  ]) {
    const html = await (await fetch(baseUrl + url)).text();
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .join("\n");
    assert.ok(!scripts.includes(name), url);
  }
});

test("serves the directory index with or without a trailing slash", async () => {
  for (const path of ["/", "/sub", "/sub/"]) {
    const res = await fetch(baseUrl + path);
    assert.equal(res.status, 200, path);
    if (path !== "/") assert.match(await res.text(), /inner\.md/, path);
  }
});

test("refuses paths that climb out of the served directory", async () => {
  assert.equal(await rawStatus("/../secret.md"), 403);
  assert.equal(await rawStatus(`/../${basename(neighborDir)}/secret.md`), 403);
  assert.equal(await rawStatus(`/${neighborDir}/secret.md`), 403); // absolute
  assert.notEqual(await rawStatus("/_appa/katex/../../../package.json"), 200);
});

test("serves a path that climbs out and back into the served directory", async () => {
  assert.equal(await rawStatus(`/../${basename(fixturesDir)}/notes.md`), 200);
});

test("serves a file whose name starts with two dots", async () => {
  const res = await fetch(`${baseUrl}/..dots.md`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1[^>]*>Dots<\/h1>/);
});

test("doesn't read files over the live-reload socket", async () => {
  const replies = await socketReplies("get_md", {
    filepath: `../${basename(neighborDir)}/secret.md`,
  });
  assert.doesNotMatch(JSON.stringify(replies), /NEIGHBOR-SECRET/);
});

test("doesn't answer on the machine's network address", async (t) => {
  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((iface) => iface.family === "IPv4" && !iface.internal)?.address;
  if (!lanAddress) {
    t.skip("no network address to try");
    return;
  }
  await assert.rejects(fetch(`http://${lanAddress}:${port}/`));
});

test("refuses requests addressed to another host name", async () => {
  // A DNS-rebinding page reaches 127.0.0.1 but still sends its own domain as the Host
  assert.equal(await rawStatus("/", { Host: "evil.example" }), 403);
  assert.equal(await rawStatus("/", { Host: `localhost:${port}` }), 200);
});

test("refuses live-reload connections from other websites", async () => {
  const handshake = "/_appa/socket.io/?EIO=4&transport=polling";
  const fromSite = (origin) => rawStatus(handshake, { Origin: origin });
  assert.equal(await fromSite("https://evil.example"), 403);
  assert.equal(await fromSite("null"), 403);
  assert.equal(await fromSite(`http://localhost:${port}`), 200);
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

// socketReplies emits one event over appa's live-reload socket and returns the events appa sends back.
//
// With change, it gives appa's file watcher time to start, runs change, then collects replies for waitMs. It fails if
// the socket.io handshake doesn't complete, so an empty result means appa answered nothing, not that the request
// never arrived.
async function socketReplies(event, payload, { change, waitMs = 1000 } = {}) {
  const socket = openSocket(event, payload);
  if (change) {
    await sleep(500);
    await change();
  }
  await sleep(waitMs);
  socket.close();

  assert.ok(socket.joined, "the socket.io handshake didn't complete");
  return socket.replies;
}

// openSocket connects to appa's live-reload socket, emits one event, and collects the events appa sends back in
// replies until close. Each call is its own connection, as each open page is.
//
// It speaks socket.io's wire protocol over a plain WebSocket, the way any client on the network could, rather than
// through appa's page.
function openSocket(event, payload) {
  const url = `ws://127.0.0.1:${port}/_appa/socket.io/?EIO=4&transport=websocket`;
  const ws = new WebSocket(url);
  const socket = { replies: [], joined: false, close: () => ws.close() };

  ws.onmessage = ({ data }) => {
    if (data.startsWith("0")) {
      ws.send("40"); // the server opened the connection; join the default namespace
    } else if (data.startsWith("40")) {
      socket.joined = true;
      ws.send(`42${JSON.stringify([event, payload])}`); // 42 = an event message
    } else if (data.startsWith("42")) {
      socket.replies.push(JSON.parse(data.slice(2)));
    }
  };
  return socket;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// rawStatus returns the status code for path, sent exactly as written with the given headers. fetch would resolve
// ".." segments before sending and won't set Host or Origin, so these requests use node:http, which does both.
function rawStatus(path, headers = {}) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
      .on("error", reject)
      .end();
  });
}
