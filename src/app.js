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
  join,
  relative,
  resolve,
  normalize,
} from "node:path";
import { fileURLToPath } from "node:url";
import { full as markdownItEmoji } from "markdown-it-emoji";
import { readdir, readFile, stat } from "node:fs/promises";

const DEBUG = false;
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const app = express();
const server = createServer(app);
const io = new Server(server);

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
  const filepathMd = `${filepath}.md`;

  const [stats, statsMd] = await getStats(filepath, filepathMd);
  if (await sendFilepath(res, stats, filepath)) return;
  if (await sendFilepath(res, statsMd, filepathMd)) return;
  res.status(404).send("Not found");
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

  socket.on("watch", (file) => {
    debug(`${socket.id} watching file ${file}`);
    let filepath;
    try {
      filepath = getRelativeFilepath(file);
    } catch (err) {
      console.log(`attempted directory traversal: ${file}`);
      return;
    }
    watcher = chokidar.watch(filepath, {
      persistent: true,
    });
    watcher.on("change", (path) => {
      const changedFile = relative(baseDir, path);
      debug(`file updated: ${path} -> ${changedFile}`);
      socket.emit("file_updated", { filepath: changedFile });
    });
  });

  socket.on("get_md", async (message) => {
    debug(`${socket.id} requested markdown file`);
    try {
      const filepath = join(baseDir, message.filepath);
      const content = await readFile(filepath, "utf8");
      const rendered = renderMd(content);
      socket.emit("set_md", { data: rendered });
    } catch (err) {
      socket.emit("set_md", { data: err.message });
    }
  });
});

function getRelativeFilepath(filepath) {
  const norm = normalize(filepath);
  if (norm.startsWith("..") || norm.startsWith("/")) {
    throw Error(`attempted directory traversal: ${filepath}`);
  }
  const resolved = resolve(baseDir, norm);
  if (!resolved.startsWith(baseDir)) {
    throw Error(`attempted directory traversal: ${filepath}`);
  }
  return resolved;
}

async function getStats(filepath, filepathMd) {
  let stats;
  let statsMd;
  try {
    stats = await stat(filepath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    statsMd = await stat(filepathMd);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  return [stats, statsMd];
}

async function sendFilepath(res, stats, filepath) {
  if (!stats) {
    return false;
  }

  if (stats.isDirectory()) {
    const files = await getFiles(filepath, "md");
    const markdown = getFilesAsMd(files);
    const html = renderMd(markdown);
    await res.render("md", {
      content: html,
      filepath: relative(baseDir, filepath),
    });
  } else if (filepath.endsWith(".md")) {
    const markdown = await readFile(filepath, "utf8");
    const html = renderMd(markdown);
    await res.render("md", {
      content: html,
      filepath: relative(baseDir, filepath),
    });
  } else {
    res.sendFile(filepath);
  }
  return true;
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

async function getFiles(dir, ext) {
  let stack = [dir];
  let files = [];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const items = await readdir(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(currentDir, item.name);
      if (item.isDirectory()) {
        stack.push(fullPath);
      } else if (item.isFile() && extname(fullPath) === `.${ext}`) {
        files.push(relative(dir, fullPath));
      }
    }
  }
  return files;
}

function getFilesAsMd(files) {
  const header = "# Markdown files";
  const body = files.map((file) => {
    const relativeURI = escapeFilePath(file);
    return `- [${file}](${relativeURI})`;
  });
  return [header, ...body].join("\n");
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
  server.listen(port, () => {
    if (cb) cb();
  });
}
