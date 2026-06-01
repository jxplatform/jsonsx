#!/usr/bin/env bun
// migrate-to-typescript.ts — Full codebase JS→TS migration
//
// Pipeline:
//   1. ts-migrate rename  — renames .js → .ts files
//   2. ts-migrate migrate — converts @param/@returns JSDoc to TS function signatures
//   3. convert-typedefs   — converts @typedef blocks to TS interfaces/types
//   4. convert-jsdoc-casts — converts inline /** @type {T} */ casts to TS equivalents
//
// Usage:
//   bun run scripts/migrate-to-typescript.ts [--dry-run] [--skip-ts-migrate]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const skipTsMigrate = process.argv.includes("--skip-ts-migrate");
const ROOT = process.cwd();
const tsMigrateCli = join(ROOT, "node_modules/ts-migrate/build/cli.js");

const PACKAGES = [
  "packages/runtime",
  "packages/parser",
  "packages/compiler",
  "packages/server",
  "packages/studio",
  "packages/schema",
  "packages/create",
];

function run(cmd: string[], label: string): boolean {
  console.log(`  $ ${cmd.join(" ")}`);
  if (dryRun) {
    console.log("    [DRY RUN] skipped\n");
    return true;
  }
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`  ERROR: ${label} failed (exit ${result.status})\n`);
    return false;
  }
  console.log();
  return true;
}

// ─── Step 1: ts-migrate rename ───────────────────────────────────────────────

if (!skipTsMigrate) {
  console.log("\n═══ Step 1: ts-migrate rename (.js → .ts) ═══\n");

  for (const pkg of PACKAGES) {
    // ts-migrate rename expects a tsconfig.json in the folder.
    // Ensure one exists (ts-migrate init creates a basic one).
    const tsconfigPath = join(ROOT, pkg, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      console.log(`  Initializing tsconfig for ${pkg}...`);
      run(["node", tsMigrateCli, "init", pkg], `ts-migrate init ${pkg}`);
    }
    if (!run(["node", tsMigrateCli, "rename", pkg], `ts-migrate rename ${pkg}`)) {
      process.exit(1);
    }
  }

  // ─── Step 2: ts-migrate migrate (jsdoc plugin converts @param/@returns) ────

  console.log("\n═══ Step 2: ts-migrate migrate (JSDoc → TS function signatures) ═══\n");

  for (const pkg of PACKAGES) {
    if (
      !run(
        ["node", tsMigrateCli, "migrate", "--plugin", "jsdoc", pkg],
        `ts-migrate migrate --plugin jsdoc ${pkg}`,
      )
    ) {
      console.log(`  Warning: migrate failed for ${pkg}, continuing...`);
    }
  }
} else {
  console.log("\n  [Skipping ts-migrate steps (--skip-ts-migrate)]\n");
}

// ─── Step 3: convert-typedefs ────────────────────────────────────────────────

console.log("\n═══ Step 3: Convert @typedef JSDoc blocks → TS interfaces/types ═══\n");

if (!run(["bun", "run", "scripts/convert-typedefs.ts"], "convert-typedefs")) {
  process.exit(1);
}

// ─── Step 4: convert-jsdoc-casts ─────────────────────────────────────────────

console.log("\n═══ Step 4: Convert inline /** @type {T} */ casts → TS equivalents ═══\n");

if (!run(["bun", "run", "scripts/convert-jsdoc-casts.ts"], "convert-jsdoc-casts")) {
  process.exit(1);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n═══ Migration Complete ═══\n");
console.log("  Next steps:");
console.log("    1. bun test            — verify tests pass");
console.log("    2. bunx tsgo           — check remaining type errors");
console.log("    3. Fix remaining errors manually");
console.log();
