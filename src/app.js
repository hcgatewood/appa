import chokidar from "chokidar";
import express from "express";
import markdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import markdownItHighlightJs from "markdown-it-highlightjs";
import markdownItKatex from "@iktakahiro/markdown-it-katex";
import markdownItTaskCheckbox from "markdown-it-task-checkbox";
import sanitizeHtml from "sanitize-html";
import { Server } from "socket.io";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { full as markdownItEmoji } from "markdown-it-emoji";
import { readdir, readFile, stat } from "node:fs/promises";

const DEBUG = false;
// socket.io answers every request under its path before appa's routes see it, so the path sits under /_appa/ with the
// page assets, where it can't hide a docs folder named socket.io
const SOCKET_PATH = "/_appa/socket.io";
// Every Markdown and HTML page loads these. socket.io's server serves the client that matches its own version.
const LIVE_RELOAD_CLIENT = `<script src="${SOCKET_PATH}/socket.io.js"></script>
<script src="/_appa/live_reload.js" data-socket-path="${SOCKET_PATH}"></script>
`;
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const app = express();
const server = createServer(app);
// Browsers let any website open a WebSocket to localhost, so live-reload connections need their own Origin check
const io = new Server(server, {
  path: SOCKET_PATH,
  allowRequest: (req, callback) => callback(null, isLocalRequest(req)),
});

const md = markdownIt({
  html: true,
  linkify: true,
})
  .use(markdownItAnchor)
  .use(markdownItTaskCheckbox)
  .use(markdownItHighlightJs)
  .use(markdownItKatex)
  .use(markdownItEmoji);

// Turn ```mermaid code blocks into <pre class="mermaid">, the element the script in md.ejs draws as a diagram.
//
// markdown-it builds each code block's HTML with the function in md.renderer.rules.fence. This replaces it with
// one that handles mermaid blocks itself and passes every other block to the original, which adds syntax
// highlighting. Mermaid source never reaches highlight.js, so it doesn't log "Could not find the language".
//
// e.g. a block holding `a --> b` becomes <pre class="mermaid">a --&gt; b</pre>, and the browser turns `&gt;`
// back into `>` before Mermaid reads it. Until Mermaid draws it, or if it can't load, the block shows that source.
const renderFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0]; // e.g. "mermaid" from ```mermaid
  if (lang !== "mermaid") {
    return renderFence(tokens, idx, options, env, self);
  }
  return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
};

let baseDir = process.cwd();

app.set("views", join(__dirname, "views"));
app.set("view engine", "ejs");
app.locals.liveReloadClient = LIVE_RELOAD_CLIENT; // md.ejs writes these into each Markdown page's <head>

// Runs before every route, so nothing below answers a request from another site or a rebound domain
app.use((req, res, next) => {
  if (!isLocalRequest(req)) {
    res.status(403).send("Forbidden");
    return;
  }
  next();
});

app.use(express.static(join(__dirname, "public")));

// Pages load their CSS, fonts, and scripts from appa's own packages rather than a CDN, so they work offline and
// each stylesheet matches the library version that rendered the page. These routes take precedence over files in
// the served directory, so they live under /_appa/, a name a docs folder won't use.
//
// Mermaid's npm package is 200 MB, almost all of it unused here, so it's only a dev dependency: the prepare script
// copies its one browser file into src/vendor, and package.json's files list ships that copy.
app.use(
  "/_appa/github-markdown-css",
  express.static(assetDir("github-markdown-css/github-markdown-light.css")),
);
app.use(
  "/_appa/highlight.js",
  express.static(
    assetDir("highlight.js/styles/default.min.css", "markdown-it-highlightjs"),
  ),
);
app.use(
  "/_appa/katex",
  express.static(
    assetDir("katex/dist/katex.min.css", "@iktakahiro/markdown-it-katex"),
  ),
);
app.use("/_appa/mermaid", express.static(join(__dirname, "vendor", "mermaid")));

app.get("/favicon.ico", (req, res) => {
  res.sendFile(join(__dirname, "public", "favicon.svg"));
});

app.get("/{*path}", async (req, res) => {
  const reqFilepath = req.params.path ? req.params.path.join("/") : ""; // params.path not set for root req
  let filepath;
  try {
    filepath = getRelativeFilepath(reqFilepath);
  } catch (err) {
    res.status(403).send(err.message);
    return;
  }

  const page = await findPage(filepath);
  if (!page) {
    res.status(404).send("Not found");
    return;
  }
  await sendPage(res, page);
});

io.on("connection", (socket) => {
  debug(`${socket.id} connected`);

  let watcher;

  socket.on("disconnect", () => {
    debug(`${socket.id} disconnected`);
    if (watcher) {
      watcher.close();
    }
  });

  // A page sends its own URL path, e.g. "/Tom%20%26%20Jerry.md", and appa finds the file the way it did for the page
  // request: Express decodes the path after its leading "/", and findPage falls back to the .md file.
  socket.on("watch", async (urlPath) => {
    debug(`${socket.id} watching ${urlPath}`);
    let page;
    try {
      const requested = getRelativeFilepath(
        decodeURIComponent(urlPath.replace(/^\//, "")),
      );
      page = await findPage(requested);
    } catch (err) {
      console.log(`can't watch ${urlPath}: ${err.message}`);
      return;
    }
    // A directory's index doesn't live-reload, and watching it would watch the whole tree below it
    if (!page || page.stats.isDirectory()) return;
    // The socket may have closed while findPage ran, and a watcher started now would never close
    if (socket.disconnected) return;

    const { filepath } = page;
    watcher?.close();
    // An HTML page also reloads when the CSS or JS beside it changes, so it watches its directory but no deeper. A
    // Markdown page watches only its own file, with no depth option: on a single file, that option can make chokidar
    // miss changes.
    watcher = isHtml(filepath)
      ? chokidar.watch(dirname(filepath), { persistent: true, depth: 0 })
      : chokidar.watch(filepath, { persistent: true });
    watcher.on("change", (path) => {
      if (!reloadsPage(filepath, path)) return;
      debug(`file updated: ${path}`);
      socket.emit("file_updated");
    });
  });
});

// getRelativeFilepath resolves a requested path against the served directory, refusing any path outside it.
//
// The path comes from a request's URL or a live-reload watch message, so the sender can aim it at any file the user
// can read, e.g. an SSH key. With appa serving ~/docs:
//   notes.md              -> ~/docs/notes.md
//   sub/../notes.md       -> ~/docs/notes.md
//   ../docs/notes.md      -> ~/docs/notes.md
//   ..dots.md             -> ~/docs/..dots.md
//   ../docs-old/notes.md  -> refused
//   ../.ssh/id_ed25519    -> refused
//   /etc/passwd           -> refused
function getRelativeFilepath(filepath) {
  const resolved = resolve(baseDir, filepath);

  // Compare whole path segments: a plain prefix check would let /docs match a neighbor like /docs-old, and a file
  // named ..dots.md starts with ".." without leaving the directory. relative() returns an absolute path only for
  // another drive, on Windows.
  const fromBase = relative(baseDir, resolved); // e.g. "sub/notes.md", or "../docs-old/notes.md"
  const isOutside =
    fromBase === ".." ||
    fromBase.startsWith(`..${sep}`) ||
    isAbsolute(fromBase);
  if (isOutside) {
    throw Error(`attempted directory traversal: ${filepath}`);
  }
  return resolved;
}

// isLocalRequest reports whether a request is addressed to this machine and, if a web page sent it, whether that
// page came from this machine too.
//
// The Host check blocks DNS rebinding, where a remote page re-points its own domain at 127.0.0.1 to reach local
// servers: the browser still sends that domain as the Host. Requests with no Origin come from programs or
// top-level navigation rather than from scripts on another site, and the loopback-only listener already limits
// programs to this machine.
function isLocalRequest(req) {
  const { host, origin } = req.headers;
  return isLoopbackHost(host) && (!origin || isLoopbackOrigin(origin));
}

// isLoopbackHost reports whether a Host header names this machine, e.g. "localhost:8082" or "[::1]:8082".
function isLoopbackHost(host = "") {
  const name = host.replace(/:\d+$/, ""); // drop the port
  return ["localhost", "127.0.0.1", "[::1]"].includes(name);
}

function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false; // e.g. "null", which sandboxed frames and file:// pages send
  }
}

// findPage finds the file a URL names: the path itself, or else the .md file for a URL that leaves it off, e.g.
// "notes" -> "notes.md". It returns the file's path and stats, or null if neither exists.
async function findPage(filepath) {
  for (const candidate of [filepath, `${filepath}.md`]) {
    try {
      return { filepath: candidate, stats: await stat(candidate) };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return null;
}

async function sendPage(res, { filepath, stats }) {
  if (stats.isDirectory()) {
    const files = await getPages(filepath);
    const markdown = getFilesAsMd(files);
    const html = renderMd(markdown);
    await res.render("md", {
      content: html,
      filepath: relative(baseDir, filepath),
    });
  } else if (isMd(filepath)) {
    const markdown = await readFile(filepath, "utf8");
    const html = renderMd(markdown);
    await res.render("md", {
      content: html,
      filepath: relative(baseDir, filepath),
    });
  } else if (isHtml(filepath)) {
    const html = await readFile(filepath, "utf8");
    res.type("html").send(withLiveReload(html));
  } else {
    res.sendFile(filepath);
  }
}

export function renderMd(inputMd) {
  const rawHtml = md.render(inputMd);
  return sanitizeHtml(rawHtml, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "input",
      "details",
      "summary",
    ],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt"],
      input: ["type", "checked", "disabled"],
      "*": ["align", "id", "class", "style", "width"],
    },
    // sms: and imessage: links open a conversation in Messages
    allowedSchemes: [
      ...sanitizeHtml.defaults.allowedSchemes,
      "sms",
      "imessage",
    ],
    // data: lets a doc embed its own images. Only <img> allows it, since an image can't run script but a data: page can.
    allowedSchemesByTag: {
      img: [...sanitizeHtml.defaults.allowedSchemes, "data"],
    },
  });
}

// getPages lists the Markdown and HTML files under dir, recursively, as paths relative to it.
async function getPages(dir) {
  let stack = [dir];
  let files = [];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const items = await readdir(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(currentDir, item.name);
      const isPage = isMd(fullPath) || isHtml(fullPath);
      if (item.isDirectory()) {
        stack.push(fullPath);
      } else if (item.isFile() && isPage) {
        files.push(relative(dir, fullPath));
      }
    }
  }
  return files;
}

function getFilesAsMd(files) {
  const header = "# Files";
  const body = files.map((file) => {
    const relativeURI = escapeFilePath(file);
    return `- [${file}](${relativeURI})`;
  });
  return [header, ...body].join("\n");
}

// isMd reports whether a path is a Markdown page, e.g. "notes.md".
function isMd(filepath) {
  return extname(filepath) === ".md";
}

// isHtml reports whether a path is an HTML page, e.g. "report.html" or "INDEX.HTM".
function isHtml(filepath) {
  return [".html", ".htm"].includes(extname(filepath).toLowerCase());
}

// reloadsPage reports whether a change to changedPath should reload the page at pagePath: always for the page's own
// file, and for an HTML page, also for the CSS and JS beside it.
function reloadsPage(pagePath, changedPath) {
  if (changedPath === pagePath) return true;
  const isAsset = [".css", ".js"].includes(extname(changedPath).toLowerCase());
  return isHtml(pagePath) && isAsset;
}

// withLiveReload adds appa's live-reload client to an HTML page, before its </body>, or at the end if it has none.
function withLiveReload(html) {
  // Search the page itself case-insensitively, rather than a lowercased copy: lowercasing can change a string's
  // length (e.g. "İ" becomes "i" plus a combining dot), so a position found in the copy would be off in the page
  const bodyEnd = [...html.matchAll(/<\/body>/gi)].at(-1)?.index ?? -1;
  if (bodyEnd === -1) return html + LIVE_RELOAD_CLIENT;
  return html.slice(0, bodyEnd) + LIVE_RELOAD_CLIENT + html.slice(bodyEnd);
}

function escapeFilePath(filepath) {
  return encodeURIComponent(filepath)
    .replace(/%2F/g, "/") // preserve slashes
    .replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); // escape parentheses
}

// assetDir returns the directory holding a package file, e.g. "katex/dist/katex.min.css" -> ".../katex/dist".
//
// With fromPackage, it resolves the file the way that package does, so it finds the exact copy the package uses
// even when npm installs another version elsewhere in node_modules.
function assetDir(file, fromPackage) {
  const resolve = fromPackage
    ? createRequire(require.resolve(fromPackage)).resolve
    : require.resolve;
  return dirname(resolve(file));
}

function debug(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

export default async function run(port, filepath, cb) {
  baseDir = filepath;
  // Loopback only: appa serves private files with no login, so it must not answer the network
  server.listen(port, "127.0.0.1", () => {
    if (cb) cb();
  });
}
