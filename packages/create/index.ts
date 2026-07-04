#!/usr/bin/env node
/**
 * Scaffold a new Jx project.
 *
 * Usage: bun create @jxsuite my-site
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { basename, resolve } from "node:path";
import { listStarters } from "@jxsuite/starters";
import { parseCliArgs } from "./cli-args";
import { generateProject } from "./generate";
import type { ProjectOptions } from "./generate";

// The first non-flag arg is the destination; --template <id> selects a starter (skips the prompt).
const { dest, template: templateFlag } = parseCliArgs(process.argv.slice(2));
if (!dest) {
  console.error("Usage: bun create @jxsuite <directory> [--template <id>]");
  process.exit(1);
}

const destPath = resolve(dest);
const dirName = basename(destPath);

// The interactive flow runs inside an async function rather than via top-level await: when a test
// Pulls this entry in with a dynamic import(), Bun's test runtime drops the continuation after a
// Top-level await (it never resumes on Windows), leaving the prompts and generate step unexecuted.
// `ready` lets the test await the same sequence. The no-arg usage guard stays at module scope so a
// Bare invocation still exits during evaluation.
async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  const name = (await rl.question(`Project name (${dirName}): `)) || dirName;
  const description = await rl.question("Description: ");
  const url = await rl.question("Production URL (https://example.com): ");

  const starters = listStarters();
  let starter = "blank";
  if (templateFlag !== undefined) {
    // Non-interactive: honor --template, falling back to blank for an unknown id.
    starter = starters.some((s) => s.id === templateFlag) ? templateFlag : "blank";
  } else if (starters.length > 0) {
    console.log("\nStart from a template:");
    console.log("  1) Blank (default)");
    for (const [i, s] of starters.entries()) {
      console.log(`  ${i + 2}) ${s.name} — ${s.tagline}`);
    }
    const templateChoice = await rl.question("Template [1]: ");
    const idx = Math.trunc(Number(templateChoice));
    if (idx >= 2 && idx <= starters.length + 1) {
      starter = starters[idx - 2]?.id ?? "blank";
    }
  }

  console.log(`
Deployment adapter:
  1) static (default)
  2) cloudflare-pages
  3) node
  4) bun
  5) cloudflare-workers
`);
  const adapterChoice = await rl.question("Adapter [1]: ");
  rl.close();

  const adapterMap: Record<string, ProjectOptions["adapter"]> = {
    1: "static",
    2: "cloudflare-pages",
    3: "node",
    4: "bun",
    5: "cloudflare-workers",
  };
  const adapter = adapterMap[adapterChoice] || "static";

  await generateProject(destPath, { adapter, description, name, starter, url });

  console.log(`
Project created at ${destPath}

Next steps:
  cd ${dest}
  bun install
  bun run dev
`);
}

// oxlint-disable-next-line unicorn/prefer-top-level-await
export const ready = main();
