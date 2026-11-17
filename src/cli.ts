#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findConfigFile, loadConfig, resolveConfig } from "./config.js";
import { updateRoutes } from "./generator.js";
import type { UserConfig } from "./types.js";
import { watchPages } from "./watch.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("rfr")
    .version(pkg.version, "-v, --version", "Output the current version")
    .option("-i, --input <directory>", "Path to the pages directory (overrides config)")
    .option("-c, --config <file>", "Path to the config file (default: rfr.config.{ts,mts,js,mjs})")
    .option("-o, --output <directory>", "Output directory (overrides config)")
    .option("-a, --adapter <name>", "Routing adapter to use")
    .option("-w, --watch", "Watch for changes and regenerate")
    .option("-b, --build", "Generate once and exit (default; cannot be combined with --watch)")
    .parse(argv);

  const opts = program.opts<{
    input?: string;
    config?: string;
    output?: string;
    adapter?: string;
    watch?: boolean;
    build?: boolean;
  }>();

  if (opts.watch && opts.build) {
    program.error("error: --watch and --build cannot be used together");
  }

  // An explicitly passed config file must exist; the default ones are optional.
  const configFile = opts.config ?? findConfigFile(process.cwd());
  const userConfig: UserConfig = configFile ? await loadConfig(configFile) : {};

  const merged: UserConfig = {
    ...userConfig,
    pages: opts.input ?? userConfig.pages,
    outDir: opts.output ?? userConfig.outDir,
    adapter: opts.adapter ?? userConfig.adapter,
  };

  const config = resolveConfig(merged, process.cwd());
  updateRoutes(config);
  console.log(`[react-fs-router] Generated ${config.outFile}`);

  if (opts.watch) {
    watchPages(config, () => {
      try {
        if (updateRoutes(config)) console.log(`[react-fs-router] Regenerated ${config.outFile}`);
      } catch (err) {
        console.error("[react-fs-router]", err);
      }
    });
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error("[react-fs-router]", err);
    process.exitCode = 1;
  });
}
