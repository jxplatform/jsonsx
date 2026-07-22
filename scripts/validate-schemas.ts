/**
 * Validate-schemas.ts — repo-wide Jx schema compliance gate (`bun run schema:validate-all`).
 *
 * Runs the same whole-project walk as `jx validate` (validateProjectTree) over every project root
 * in the repo: examples/, sites/_, packages/starters/sites/_, and the screenshot fixtures. Any
 * invalid document, class file, fragment, project.json, or non-self-contained committed entry
 * document fails the run — the CI net that keeps schema, spec, and usage from drifting.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  formatProjectTreeIssues,
  validateProjectTree,
} from "../packages/compiler/src/site/validate-command.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

function projectRootsIn(parent: string): string[] {
  const dir = resolve(REPO_ROOT, parent);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => existsSync(join(path, "project.json")))
    .toSorted();
}

const roots = [
  resolve(REPO_ROOT, "examples"),
  ...projectRootsIn("sites"),
  ...projectRootsIn("packages/starters/sites"),
  ...projectRootsIn("scripts/screenshots/fixtures"),
];

let failures = 0;
let filesChecked = 0;
for (const root of roots) {
  const label = relative(REPO_ROOT, root);
  try {
    const result = await validateProjectTree(root);
    filesChecked += result.checked;
    if (result.valid) {
      console.log(`ok   ${label} (${result.checked} files)`);
    } else {
      failures += 1;
      console.error(`FAIL ${label}:`);
      for (const line of formatProjectTreeIssues(result)) {
        console.error(`     ${line}`);
      }
    }
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${roots.length} projects, ${filesChecked} files checked, ${failures} failing`);
if (failures > 0) {
  process.exit(1);
}
