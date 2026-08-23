// Fail when a built Studio bundle exceeds its committed size ceiling. Studio's bundle is otherwise
// Unmonitored (the codecov bundle path is broken), so this is the guard against silent size creep.
//
// Usage: bun packages/studio/scripts/check-bundle-budget.ts   (run after `bun run build`)
// Skips (exit 0) when dist is not built, so it is safe to run in any order; wire it AFTER the build.

import { existsSync, statSync } from "node:fs";
import { Glob } from "bun";
import { dirname, join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "..");
const DIST = join(PKG, "dist");
const BUDGET_PATH = join(PKG, "bundle-budget.json");

interface Budget {
  tolerance?: number;
  budgets: Record<string, number>;
}

const { tolerance = 0, budgets } = JSON.parse(await Bun.file(BUDGET_PATH).text()) as Budget;

if (!existsSync(DIST)) {
  console.log("bundle budget: dist/ not built — skipping (run `bun run build` first to enforce).");
  process.exit(0);
}

const violations: string[] = [];
for (const [file, ceiling] of Object.entries(budgets)) {
  const path = join(DIST, file);
  if (!existsSync(path)) {
    /* A declared key that is not there is a FAILURE, not a skip. The skip is how a budget quietly
       stops measuring anything: rename the artifact and every ceiling passes forever. */
    violations.push(`${file}: declared in bundle-budget.json but not present in dist/`);
    continue;
  }
  /* A directory key budgets the whole tree, minus source maps — dist/chunks is 192 files and no
     single one of them is the thing worth a ceiling. */
  const stats = statSync(path);
  const size = stats.isDirectory()
    ? [...new Glob("**/*").scanSync(path)]
        .filter((rel) => !rel.endsWith(".map"))
        .reduce((n, rel) => n + statSync(join(path, rel)).size, 0)
    : stats.size;
  const limit = Math.round(ceiling * (1 + tolerance));
  const pct = ((size / ceiling) * 100).toFixed(1);
  if (size > limit) {
    violations.push(
      `${file}: ${size} bytes exceeds ceiling ${ceiling} +${tolerance * 100}% = ${limit} (${pct}% of budget). ` +
        `Raise the ceiling in ${dirname(BUDGET_PATH).split("/").slice(-2).join("/")}/bundle-budget.json only with justification.`,
    );
  } else {
    console.log(`bundle budget: ${file} ${size} bytes (${pct}% of ${ceiling} budget) — OK.`);
  }
}

if (violations.length > 0) {
  console.error(`\nbundle budget: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  process.exit(1);
}
