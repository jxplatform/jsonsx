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
  db push [root]   Sync the data section's tables to their connections (additive-only)

Options:
  --verbose      Print detailed build progress
  --no-clean     Don't clean outDir before building
  --dry-run      db push: print the statements without executing them
  --connection   db push: restrict to one connection name`);
    process.exit(0);
  }

  // `db push` is a two-word command; normalize it before the flag/positional split.
  const isDb = command === "db";
  const dbSubcommand = isDb ? args[1] : null;
  const rest = args.slice(isDb ? 2 : 1);
  const flags = new Set<string>();
  const positionals: string[] = [];
  let connectionArg: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--connection") {
      index += 1;
      connectionArg = rest[index];
    } else if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }
  const [positional] = positionals;
  const projectRoot = resolve(positional ?? ".");

  if (isDb) {
    if (dbSubcommand !== "push") {
      console.error(
        `Unknown db subcommand: ${dbSubcommand ?? "(none)"}\nUsage: jx db push [root] [--dry-run] [--connection <name>]`,
      );
      process.exit(1);
    }
    const dryRun = flags.has("--dry-run");
    try {
      const { dbPush } = await import("./site/db-push.ts");
      const { results, bindingsPatched, wranglerPath } = await dbPush(projectRoot, {
        dryRun,
        ...(connectionArg === undefined ? {} : { connection: connectionArg }),
      });
      for (const result of results) {
        const mode = result.applied ? "applied" : "dry-run";
        console.log(
          `${result.connection} (${result.provider}) — ${result.tables.length} table(s), ` +
            `${result.statements.length} statement(s) [${mode}]`,
        );
        for (const statement of result.statements) {
          console.log(`  ${statement}`);
        }
        for (const warning of result.warnings) {
          console.warn(`  warning: ${warning}`);
        }
      }
      if (bindingsPatched && wranglerPath) {
        console.log(`Updated bindings in ${relative(projectRoot, wranglerPath)}`);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`db push failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

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
