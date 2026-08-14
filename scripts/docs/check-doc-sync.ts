// Advisory doc-sync check: maps changed source files to the documentation that
// Describes them and reports pages/specs the diff did NOT touch. The map comes
// From the traceability conventions check-doc-refs.ts validates — docs pages'
// `code:` frontmatter and `@docs <slug>` tags in source comments — so it only
// Knows about associations that are declared. It is a prompt to THINK, not a
// Gate: behavior changes need doc/spec updates, refactors usually don't.
//
// Usage:
//   `bun scripts/docs/check-doc-sync.ts` — working tree vs HEAD
//   `... --staged` — staged files only; `... --base <ref>` — working tree vs ref
//   `... --strict` — exit 1 on findings
//
// Consumed by the Claude Code Stop hook (.claude/hooks/doc-sync.js) and as a
// Non-blocking warning in .husky/pre-commit.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { DEFAULT_MANIFEST, shotsByDocsPage } from "../check-image-lock";

const ROOT = resolve(import.meta.dir, "../..");
const DOCS_DIR = join(ROOT, "docs");

/**
 * Docs slug → the screenshot shots that illustrate it (UX-REDESIGN-PLAN §13.5).
 *
 * Both halves of this join already existed and never met: shots carry `docs:`, and this file maps a
 * diff to pages. Without the join the report says "you changed the components page's code" and
 * stays silent about the picture on that page being of the old thing — which is the residual Lane 1
 * structurally cannot see, since a command that still exists and now means something different
 * passes the contract check green.
 */
function loadShotsByPage(): Map<string, string[]> {
  try {
    const source = readFileSync(join(ROOT, DEFAULT_MANIFEST), "utf8");
    return shotsByDocsPage(JSON.parse(source));
  } catch {
    return new Map<string, string[]>();
  }
}

const shotsByPage = loadShotsByPage();

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const staged = args.includes("--staged");
const baseIndex = args.indexOf("--base");
const base = baseIndex === -1 ? "HEAD" : (args[baseIndex + 1] ?? "HEAD");

// ─── Changed files ───────────────────────────────────────────────────────────

function gitLines(gitArgs: string[]): string[] {
  try {
    return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const changed = new Set(
  staged ? gitLines(["diff", "--name-only", "--cached"]) : gitLines(["diff", "--name-only", base]),
);
if (changed.size === 0) {
  process.exit(0);
}

// ─── Association map (declared associations only) ────────────────────────────

interface PageInfo {
  slug: string;
  specs: string[];
}

/** Source file (repo-relative) → docs pages that declare it. */
const bySource = new Map<string, PageInfo[]>();

function pageFile(slug: string): string | null {
  if (existsSync(join(DOCS_DIR, `${slug}.md`))) {
    return `docs/${slug}.md`;
  }
  if (existsSync(join(DOCS_DIR, slug, "index.md"))) {
    return `docs/${slug}/index.md`;
  }
  return null;
}

// Docs pages' `code:` frontmatter
for (const rel of new Bun.Glob("**/*.md").scanSync({ cwd: DOCS_DIR })) {
  const source = readFileSync(join(DOCS_DIR, rel), "utf8");
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    continue;
  }
  let fm: { code?: unknown; spec?: unknown };
  try {
    fm = Bun.YAML.parse(match[1]!) as { code?: unknown; spec?: unknown };
  } catch {
    continue;
  }
  const codes = Array.isArray(fm.code) ? fm.code : [];
  if (codes.length === 0) {
    continue;
  }
  const specs = (Array.isArray(fm.spec) ? fm.spec : []).filter(
    (s): s is string => typeof s === "string",
  );
  const slug = rel.replace(/(\/index)?\.md$/, "");
  for (const code of codes) {
    if (typeof code !== "string") {
      continue;
    }
    bySource.set(code, [...(bySource.get(code) ?? []), { slug, specs }]);
  }
}

// `@docs <slug>` tags inside changed source files
const DOCS_TAG_RE = /@docs\s+([A-Za-z0-9/_-]+)/g;
for (const file of changed) {
  if (!/^(packages|extensions)\/[^/]+\/src\/.*\.ts$/.test(file)) {
    continue;
  }
  const abs = join(ROOT, file);
  if (!existsSync(abs)) {
    continue;
  }
  const source = readFileSync(abs, "utf8");
  for (const m of source.matchAll(DOCS_TAG_RE)) {
    const slug = m[1]!;
    if (pageFile(slug)) {
      bySource.set(file, [...(bySource.get(file) ?? []), { slug, specs: [] }]);
    }
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

interface Finding {
  file: string;
  pages: { slug: string; pagePath: string; specs: string[] }[];
}

const findings: Finding[] = [];
for (const file of changed) {
  const pages = bySource.get(file);
  if (!pages) {
    continue;
  }
  const stale = [];
  for (const { slug, specs } of pages) {
    const pagePath = pageFile(slug);
    if (!pagePath) {
      continue;
    }
    const specPaths = specs.map((s) => `specs/${s.split("#")[0]}`);
    const touched = changed.has(pagePath) || specPaths.some((p) => changed.has(p));
    if (!touched) {
      stale.push({ pagePath, slug, specs });
    }
  }
  if (stale.length > 0) {
    findings.push({ file, pages: stale });
  }
}

if (findings.length === 0) {
  process.exit(0);
}

console.error(
  `docs sync: ${findings.length} changed source file(s) are documented, but the diff ` +
    `touches neither their docs page(s) nor the linked spec(s):`,
);
let shotsNamed = false;
for (const { file, pages } of findings) {
  console.error(`  ${relative(ROOT, join(ROOT, file))}`);
  for (const { pagePath, slug, specs } of pages) {
    const specNote = specs.length > 0 ? ` (spec: ${specs.join(", ")})` : "";
    const shots = shotsByPage.get(slug) ?? [];
    const shotNote = shots.length > 0 ? ` [shot: ${shots.join(", ")}]` : "";
    shotsNamed ||= shots.length > 0;
    console.error(`    → ${pagePath}${specNote}${shotNote}`);
  }
}
console.error(
  "If the change alters behavior, update the page(s) and spec section(s) in the same " +
    "change set; if it's a pure refactor, no update is needed.",
);
if (shotsNamed) {
  console.error(
    "A [shot: …] page is illustrated by a screenshot of the surface you changed. The picture is " +
      "re-captured by the screenshots CI lane, but the PROSE around it is yours — re-read it.",
  );
}
process.exit(strict ? 1 : 0);
