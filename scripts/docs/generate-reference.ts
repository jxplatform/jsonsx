// Regenerates the product-data-derived reference pages under /docs. Each page is
// Committed; CI runs this and fails on a diff (`bun run docs:verify`) so the
// Pages cannot drift from the packages they document.
//
// Usage: bun scripts/docs/generate-reference.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { generateFormulas } from "./generators/formulas.ts";
import { generateImplementationStatus } from "./generators/implementation-status.ts";
import { generateOperators } from "./generators/operators.ts";
import { generateSpecChangelog } from "./generators/spec-changelog.ts";
import { generateStarters } from "./generators/starters.ts";
import { generateStudioRoutes } from "./generators/studio-routes.ts";

const ROOT = resolve(import.meta.dir, "../..");

const PAGES: Record<string, () => string> = {
  "docs/extending/reference/studio-routes.md": generateStudioRoutes,
  "docs/extending/reference/implementation-status.md": generateImplementationStatus,
  "docs/extending/reference/spec-changelog.md": generateSpecChangelog,
  "docs/framework/reference/formulas.md": generateFormulas,
  "docs/framework/reference/operators.md": generateOperators,
  "docs/studio/projects/starters.md": generateStarters,
};

const written: string[] = [];
for (const [relPath, generate] of Object.entries(PAGES)) {
  const path = join(ROOT, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generate(), "utf8");
  written.push(path);
  console.log(`wrote ${relPath}`);
}

// Format the generated pages so their committed form is oxfmt-stable: `docs:verify` diffs the
// Regenerated output against the committed pages, and the repo-wide `bun run format` must not
// Change them afterward — both require generator output to already be formatted.
const fmt = Bun.spawnSync(["bunx", "oxfmt", ...written], { cwd: ROOT });
if (fmt.exitCode !== 0) {
  console.error(fmt.stderr.toString() || fmt.stdout.toString());
  process.exit(fmt.exitCode);
}
