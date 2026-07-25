/**
 * Generate-schemas.ts — regenerate every committed entry document (`bun run schema:generate-all`).
 *
 * Runs `jx schema` (writeProjectSchemas) over the same project roots that
 * `scripts/validate-schemas.ts` validates: examples/, sites/_, packages/starters/sites/_, and the
 * screenshot fixtures. Committed `project.schema.json` / `document.schema.json` files are generated
 * artifacts, so any change to the emitters, the bundler, the flattener, or an extension fragment
 * means rerunning this in the same PR — `schema:validate-all` is the gate that catches skipping
 * it.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { writeProjectSchemas } from "../packages/compiler/src/site/schema-command.ts";

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
for (const root of roots) {
  const label = relative(REPO_ROOT, root);
  try {
    await writeProjectSchemas(root);
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${roots.length} projects regenerated, ${failures} failing`);
if (failures > 0) {
  process.exit(1);
}
