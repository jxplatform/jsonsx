#!/usr/bin/env node
/**
 * Scaffold a new Jx project.
 *
 * Usage: bun create @jxsuite my-site
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { basename, resolve } from "node:path";
import { generateProject } from "./generate";
import type { ProjectOptions } from "./generate";

const [dest] = process.argv.slice(2);
if (!dest) {
  console.error("Usage: bun create @jxsuite <directory>");
  process.exit(1);
}

const destPath = resolve(dest);
const dirName = basename(destPath);

const rl = createInterface({ input: stdin, output: stdout });

const name = (await rl.question(`Project name (${dirName}): `)) || dirName;
const description = await rl.question("Description: ");
const url = await rl.question("Production URL (https://example.com): ");

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

await generateProject(destPath, { adapter, description, name, url });

console.log(`
Project created at ${destPath}

Next steps:
  cd ${dest}
  bun install
  bun run dev
`);
