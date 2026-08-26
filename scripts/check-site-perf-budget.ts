// Fail when a compiled site's first visit outgrows its committed ceiling.
//
// Usage: bun scripts/check-site-perf-budget.ts <site-dir>   (run AFTER `jx build`)
//
// Why this exists: jxsuite.com once shipped 491 KiB to render a marketing page — 400 KiB of it a
// Search index no visitor had asked for, and every script unminified — and nothing in the repo
// Noticed, because no check measured the built output at all. The numbers below are a tripwire, not
// A target: they fail when the emitted bytes grow, and say by how much.
//
// A page's ceiling covers what a FIRST VISIT actually downloads before it can be interactive: the
// HTML plus every same-origin asset the HTML itself points at eagerly — stylesheets, scripts,
// Preloads. The set is DERIVED from the built HTML rather than listed here, so an asset added to a
// Page is caught by the ceiling instead of needing this file edited to notice it. A module reached
// Only through a dynamic `import()` is correctly invisible: it is not in the HTML, and not in the
// First visit.
//
// Images are deliberately excluded. `srcset` means there is no single "the" image, and which
// Candidate a visitor fetches depends on their viewport — a number this check cannot honestly claim.
//
// Sizes are gzip, because that is what a static host serves. Level 9 is a stable proxy rather than
// A promise about the wire (most hosts run ~6, and Brotli where offered is smaller still); it is
// Held fixed so the comparison between two builds is meaningful even though the absolute figure is
// Slightly optimistic.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

interface Budget {
  tolerance?: number;
  /** Page path in dist → gzip ceiling for the page and everything it eagerly loads. */
  pages?: Record<string, number>;
  /** Single file in dist → its own gzip ceiling. */
  files?: Record<string, number>;
}

/** Eager, same-origin references in built HTML: stylesheets, scripts, preloads. */
const EAGER_REF =
  /<(?:link[^>]*\brel="(?:stylesheet|modulepreload|preload)"[^>]*\bhref="([^"]+)"|link[^>]*\bhref="([^"]+)"[^>]*\brel="(?:stylesheet|modulepreload|preload)"|script[^>]*\bsrc="([^"]+)")/gi;

const GZIP_LEVEL = 9;

function gzipSize(path: string): number {
  return Bun.gzipSync(readFileSync(path), { level: GZIP_LEVEL }).length;
}

/** The dist-relative paths a page eagerly pulls in, deduped, ignoring cross-origin and data URLs. */
export function eagerRefs(html: string): string[] {
  const seen = new Set<string>();
  for (const match of html.matchAll(EAGER_REF)) {
    const href = match[1] ?? match[2] ?? match[3];
    if (href === undefined || !href.startsWith("/") || href.startsWith("//")) {
      continue;
    }
    seen.add(href.replace(/^\//, "").split(/[?#]/)[0] as string);
  }
  return [...seen];
}

/** The CLI, guarded so importing this module for its helpers runs nothing. */
export function main(): number {
  const siteDir = resolve(process.argv[2] ?? ".");
  const dist = join(siteDir, "dist");
  const budgetPath = join(siteDir, "perf-budget.json");

  if (!existsSync(budgetPath)) {
    console.error(`perf budget: no perf-budget.json in ${siteDir}`);
    return 1;
  }
  if (!existsSync(dist)) {
    console.log("perf budget: dist/ not built — skipping (run the site build first to enforce).");
    return 0;
  }

  const {
    tolerance = 0,
    pages = {},
    files = {},
  } = JSON.parse(readFileSync(budgetPath, "utf8")) as Budget;

  const violations: string[] = [];

  function check(label: string, size: number, ceiling: number, detail = ""): void {
    const limit = Math.round(ceiling * (1 + tolerance));
    const pct = ((size / ceiling) * 100).toFixed(1);
    if (size > limit) {
      violations.push(
        `${label}: ${size} gz bytes exceeds ceiling ${ceiling} +${tolerance * 100}% = ${limit} ` +
          `(${pct}% of budget).${detail} Raise the ceiling in perf-budget.json only with justification.`,
      );
      return;
    }
    console.log(`perf budget: ${label} ${size} gz bytes (${pct}% of ${ceiling}) — OK.${detail}`);
  }

  for (const [page, ceiling] of Object.entries(pages)) {
    const pagePath = join(dist, page);
    if (!existsSync(pagePath)) {
      /* A declared key that is not there is a FAILURE, not a skip — renaming the artifact must not
         quietly retire its ceiling. */
      violations.push(`${page}: declared in perf-budget.json but not present in dist/`);
      continue;
    }
    const html = readFileSync(pagePath, "utf8");
    let total = gzipSize(pagePath);
    const missing: string[] = [];
    const parts: string[] = [];
    for (const ref of eagerRefs(html)) {
      const refPath = join(dist, ref);
      if (!existsSync(refPath) || statSync(refPath).isDirectory()) {
        missing.push(ref);
        continue;
      }
      const size = gzipSize(refPath);
      total += size;
      parts.push(`${ref} ${size}`);
    }
    if (missing.length > 0) {
      // A page pointing at a file the build did not write is a broken page, whatever it weighs.
      violations.push(
        `${page}: references ${missing.length} missing asset(s): ${missing.join(", ")}`,
      );
    }
    check(`${page} (first visit)`, total, ceiling, ` [${parts.join(", ")}]`);
  }

  for (const [file, ceiling] of Object.entries(files)) {
    const path = join(dist, file);
    if (!existsSync(path)) {
      violations.push(`${file}: declared in perf-budget.json but not present in dist/`);
      continue;
    }
    check(file, gzipSize(path), ceiling);
  }

  if (violations.length > 0) {
    console.error(`\nperf budget: ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`  ${v}`);
    }
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
