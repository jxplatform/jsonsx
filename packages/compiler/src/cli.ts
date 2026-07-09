#!/usr/bin/env node
/**
 * Jx — Unified CLI for the Jx platform
 *
 * Commands: jx build [project-root] [--verbose] [--no-clean] jx schema [project-root] jx validate
 * [project-root]
 *
 * @module jx-cli
 */

import { relative, resolve } from "node:path";

// The CLI body runs inside an async function rather than via top-level await: when a test pulls this
// Entry in with a dynamic import(), Bun's test runtime drops the continuation after a top-level await
// (it never resumes on Windows), so the build step would silently never run. `ready` lets the
// In-process CLI harness await the same sequence.
async function main() {
  const args = process.argv.slice(2);
  const [command] = args;

  if (!command || command === "--help" || command === "-h") {
    console.log(`Usage: jx <command> [options]

Commands:
  build [root]     Build a Jx site to dist/
  schema [root]    Generate project.schema.json + document.schema.json from project.json#/extensions
  validate [root]  Validate project.json against its generated project.schema.json

Options:
  --verbose      Print detailed build progress
  --no-clean     Don't clean outDir before building`);
    process.exit(0);
  }

  const rest = args.slice(1);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.find((a) => !a.startsWith("--"));
  const projectRoot = resolve(positional ?? ".");

  if (command === "build") {
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
  } else if (command === "schema") {
    try {
      const { writeProjectSchemas } = await import("./site/schema-command.ts");
      const { projectSchemaPath, documentSchemaPath } = await writeProjectSchemas(projectRoot);
      console.log(`Wrote ${relative(projectRoot, projectSchemaPath)}`);
      console.log(`Wrote ${relative(projectRoot, documentSchemaPath)}`);
    } catch (error) {
      const err = error as Error;
      console.error(`Schema generation failed: ${err.message}`);
      process.exit(1);
    }
  } else if (command === "validate") {
    try {
      const { validateProjectFile } = await import("@jxsuite/schema/validate-project");
      const { valid, errors } = await validateProjectFile(projectRoot);
      if (valid) {
        console.log(`project.json is valid (${projectRoot})`);
      } else {
        console.error(`project.json is INVALID (${projectRoot}):`);
        for (const error of errors ?? []) {
          const { instancePath, message } = (error ?? {}) as {
            instancePath?: string;
            message?: string;
          };
          console.error(`  - ${instancePath || "/"}: ${message ?? JSON.stringify(error)}`);
        }
        process.exit(1);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`Validation failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}\nRun "jx --help" for usage.`);
    process.exit(1);
  }
}

// oxlint-disable-next-line unicorn/prefer-top-level-await
export const ready = main();
