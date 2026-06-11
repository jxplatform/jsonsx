#!/usr/bin/env node
/**
 * Jx — Unified CLI for the Jx platform
 *
 * Commands: jx build [project-root] [--verbose] [--no-clean]
 *
 * @module jx-cli
 */

import { resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`Usage: jx <command> [options]

Commands:
  build [root]   Build a Jx site to dist/

Options:
  --verbose      Print detailed build progress
  --no-clean     Don't clean outDir before building`);
  process.exit(0);
}

if (command === "build") {
  const rest = args.slice(1);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));

  const projectRoot = resolve(positional[0] ?? ".");
  const verbose = flags.has("--verbose");
  const clean = !flags.has("--no-clean");

  console.log(`Building site from ${projectRoot}...`);

  try {
    const { buildSite } = await import("./site/site-build.ts");
    const result = await buildSite(projectRoot, { clean, verbose });

    if (result.errors.length > 0) {
      console.error(`\nBuild completed with ${result.errors.length} error(s):`);
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    console.log(`\nDone: ${result.routes} routes → ${result.files} files`);
  } catch (error) {
    const err = error as Error;
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}\nRun "jx --help" for usage.`);
  process.exit(1);
}
