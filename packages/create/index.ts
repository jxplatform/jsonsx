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
import { isTemplateId, listTemplates } from "./templates";
import type { ProjectOptions } from "./generate";
import type { TemplateId } from "./templates";

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
  const templates = listTemplates();
  let starter = "blank";
  let template: TemplateId = "blank";
  if (templateFlag !== undefined) {
    // Non-interactive: honor --template — built-in template ids win over starter ids, and an
    // Unknown id falls back to blank.
    if (isTemplateId(templateFlag)) {
      template = templateFlag;
    } else if (starters.some((s) => s.id === templateFlag)) {
      starter = templateFlag;
    }
  } else {
    console.log("\nStart from a template:");
    for (const [i, t] of templates.entries()) {
      console.log(`  ${i + 1}) ${t.name}${i === 0 ? " (default)" : ""}`);
    }
    for (const [i, s] of starters.entries()) {
      console.log(`  ${i + templates.length + 1}) ${s.name} — ${s.tagline}`);
    }
    const templateChoice = await rl.question("Template [1]: ");
    const idx = Math.trunc(Number(templateChoice));
    if (idx >= 2 && idx <= templates.length) {
      template = templates[idx - 1]?.id ?? "blank";
    } else if (idx > templates.length && idx <= templates.length + starters.length) {
      starter = starters[idx - templates.length - 1]?.id ?? "blank";
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

  await generateProject(destPath, { adapter, description, name, starter, template, url });

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
