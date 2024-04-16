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

let baseDir = process.cwd();

app.set("views", join(__dirname, "views"));
app.set("view engine", "ejs");

app.get("/:path(*)", async (req, res) => {
  let filepath;
  try {
    filepath = getRelativeFilepath(req.params.path);
  } catch (err) {
    res.status(403).send(err.message);
    return;
  }

  try {
    await stat(filepath);
  } catch (err) {
    res.status(404).send("file not found");
    return;
  }

  const stats = await stat(filepath);

  if (stats.isDirectory()) {
    const files = await getFiles(filepath, "md");
    const markdown = getFilesAsMd(files);
    const html = renderMd(markdown);
    res.render("md", { content: html, filepath: relative(baseDir, filepath) });
  } else if (filepath.endsWith(".md")) {
    const markdown = await readFile(filepath, "utf8");
    const html = renderMd(markdown);
    res.render("md", { content: html, filepath: relative(baseDir, filepath) });
  } else {
    res.sendFile(filepath);
  }
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

function renderMd(inputMd) {
  const rawHtml = md.render(inputMd);
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "input"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt"],
      input: ["type", "checked", "disabled"],
      "*": ["align", "id", "class", "style", "width"],
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
    return `- [${file}](${file})`;
  });
  return [header, ...body].join("\n");
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
