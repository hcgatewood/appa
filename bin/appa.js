#!/usr/bin/env node

import { createCommand } from "commander";
import open from "open";
import run from "../src/app.js";
import { dirname, basename, join, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";

const program = createCommand();

program
  .option(
    "-p, --port <port>",
    "Port to run the server on",
    process.env.PORT || "3000",
  )
  .option("-o, --open", "Open browser after starting the server");

program
  .command("start [filepath]")
  .description("Start the server and optionally open a browser")
  .action((filepath = "") => {
    const [dir, file] = getFilenames(filepath);
    run(program.opts().port, dir, async (err) => {
      if (err) throw err;
      const uri = `http://localhost:${program.opts().port}/${file}`;
      if (program.opts().open) await open(uri);
      log(`appa started at ${uri}`);
    });
  });

function getFilenames(filepath) {
  filepath = normalize(filepath);
  if (!filepath.startsWith("/")) {
    filepath = join(process.cwd(), filepath);
  }

  if (!existsSync(filepath)) {
    throw Error(`File or directory not found: ${filepath}`);
  }

  if (statSync(filepath).isDirectory()) {
    return [filepath, ""];
  } else {
    return [dirname(filepath), basename(filepath)];
  }
}

function log(message) {
  console.log(`[appa] ${message}`);
}

program.parse(process.argv);
