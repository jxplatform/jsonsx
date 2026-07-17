// Regenerates the product-data-derived reference pages under /docs. Each page is
// Committed; CI runs this and fails on a diff (`bun run docs:verify`) so the
// Pages cannot drift from the packages they document.
//
// Usage: bun scripts/docs/generate-reference.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { generateFormulas } from "./generators/formulas.ts";
import { generateOperators } from "./generators/operators.ts";
import { generateStarters } from "./generators/starters.ts";
import { generateStudioRoutes } from "./generators/studio-routes.ts";

const ROOT = resolve(import.meta.dir, "../..");

const PAGES: Record<string, () => string> = {
  "docs/extending/reference/studio-routes.md": generateStudioRoutes,
  "docs/framework/reference/formulas.md": generateFormulas,
  "docs/framework/reference/operators.md": generateOperators,
  "docs/studio/projects/starters.md": generateStarters,
};

for (const [relPath, generate] of Object.entries(PAGES)) {
  const path = join(ROOT, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generate(), "utf8");
  console.log(`wrote ${relPath}`);
}
