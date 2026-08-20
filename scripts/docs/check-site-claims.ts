// Blocking gate for marketing-copy truthfulness. Scans sites/jxsuite.com/pages/** and README.md
// For unbacked claims, dead download links, wrong starter counts, and missing LICENSE files, so
// Untrue copy cannot ship. Companion to check-doc-refs.ts (which covers /docs). Sources of truth:
//   - scripts/docs/claims.json          — forbidden-claim patterns + evidence-backed allowlist
//   - packages/desktop/release-assets.json — canonical release asset filenames + signing status
//   - packages/starters/registry.json    — the starter count
//   - scripts/screenshots/manifest.json  — the screenshots a page may reference
//
// Usage: bun scripts/docs/check-site-claims.ts

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SITE_PAGES = join(ROOT, "sites/jxsuite.com/pages");
const README = join(ROOT, "README.md");
const CLAIMS_PATH = join(ROOT, "scripts/docs/claims.json");
const RELEASE_ASSETS_PATH = join(ROOT, "packages/desktop/release-assets.json");
const REGISTRY_PATH = join(ROOT, "packages/starters/registry.json");
const MANIFEST_PATH = join(ROOT, "scripts/screenshots/manifest.json");
const SCREENSHOTS_DIR = join(ROOT, "docs/images");

const violations: string[] = [];
const fail = (file: string, message: string) => {
  violations.push(`${relative(ROOT, file)}: ${message}`);
};

// ─── Sources of truth ─────────────────────────────────────────────────────────

interface Pattern {
  id: string;
  regex: string;
  flags?: string;
  hint: string;
}
interface AllowEntry {
  id: string;
  file: string;
  text: string;
  evidence?: string;
  reason?: string;
}
interface Claims {
  patterns: Pattern[];
  allow: AllowEntry[];
}
interface ReleaseAsset {
  file: string;
  platform: string;
  signed: boolean;
  downloadable: boolean;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const claims = readJson<Claims>(CLAIMS_PATH);
const releaseAssets = readJson<{ assets: ReleaseAsset[] }>(RELEASE_ASSETS_PATH).assets;
const downloadableAssets = new Set(releaseAssets.filter((a) => a.downloadable).map((a) => a.file));
/*
 * The registry is an ARRAY of starter entries. `Object.keys(...).length` answered 13 only
 * because Object.keys on an array enumerates its indices — typed as a Record it claimed to be
 * counting keys, so the day the file grows a wrapper object it would count 1 and say nothing.
 */
const registry = readJson<unknown>(REGISTRY_PATH);
if (!Array.isArray(registry)) {
  throw new TypeError(`${relative(ROOT, REGISTRY_PATH)} must be a JSON array of starter entries.`);
}
export const starterIds: string[] = registry.map((entry) => (entry as { id: string }).id);
export const starterCount = registry.length;

// Track which allow entries actually matched something, so stale entries are flagged.
const usedAllow = new Set<AllowEntry>();

// ─── File collection ────────────────────────────────────────────────────────

/** All target files: every page under the site pages dir plus the README. */
export function targetFiles(): string[] {
  const out: string[] = [README];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".md") || full.endsWith(".json")) {
        out.push(full);
      }
    }
  };
  if (existsSync(SITE_PAGES)) {
    walk(SITE_PAGES);
  }
  return out;
}

// ─── Forbidden-claim lint ─────────────────────────────────────────────────────

/** An allow entry covers a hit when its id + file match and its `text` is a substring of the line. */
function isAllowed(patternId: string, repoFile: string, line: string): boolean {
  for (const entry of claims.allow) {
    if (entry.id === patternId && entry.file === repoFile && line.includes(entry.text)) {
      usedAllow.add(entry);
      return true;
    }
  }
  return false;
}

function lintClaims(): void {
  const compiled = claims.patterns.map((p) => ({
    ...p,
    re: new RegExp(p.regex, p.flags ?? ""),
  }));

  for (const file of targetFiles()) {
    // Forward-slash: `claims.json` writes repo paths one way, and `relative()` answers in the
    // OS separator. On Windows every allow entry therefore matched nothing, which failed the check
    // Twice over — once for the claim it was allowing, once for going "stale".
    const repoFile = relative(ROOT, file).replaceAll("\\", "/");
    const isMarkdown = file.endsWith(".md");
    const lines = readFileSync(file, "utf8").split("\n");
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isMarkdown && line.trimStart().startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      // Forbidden-claim patterns apply to prose/data, not to fenced code blocks in markdown.
      if (inFence) {
        continue;
      }
      for (const p of compiled) {
        if (p.re.test(line) && !isAllowed(p.id, repoFile, line)) {
          fail(
            file,
            `${i + 1}: [${p.id}] "${line.trim().slice(0, 90)}"\n      ${p.hint}\n      Fix: reword/remove, or add an allow entry with evidence to scripts/docs/claims.json.`,
          );
        }
      }
    }
  }
}

/** Allow entries that matched nothing are stale — a reword left them behind. */
function checkStaleAllow(): void {
  for (const entry of claims.allow) {
    if (!usedAllow.has(entry)) {
      fail(
        CLAIMS_PATH,
        `stale allow entry [${entry.id}] for ${entry.file} text "${entry.text}" matched nothing — remove it.`,
      );
    }
    const ev = entry.evidence;
    if (ev && !ev.includes("#") && !existsSync(join(ROOT, ev))) {
      fail(CLAIMS_PATH, `allow entry [${entry.id}] evidence path "${ev}" does not exist.`);
    }
    if (!entry.evidence && !entry.reason) {
      fail(CLAIMS_PATH, `allow entry [${entry.id}] for ${entry.file} needs an evidence or reason.`);
    }
  }
}

// ─── Download links ───────────────────────────────────────────────────────────

const DOWNLOAD_RE = /releases\/latest\/download\/([A-Za-z0-9._-]+)/g;

function checkDownloadLinks(): void {
  const files = [README, ...targetFiles().filter((f) => f !== README)];
  // Also scan docs pages, where the same installer links live.
  const docsDir = join(ROOT, "docs");
  const walkDocs = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walkDocs(full);
      } else if (full.endsWith(".md")) {
        files.push(full);
      }
    }
  };
  if (existsSync(docsDir)) {
    walkDocs(docsDir);
  }

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(DOWNLOAD_RE)) {
      const asset = match[1]!;
      if (!downloadableAssets.has(asset)) {
        fail(
          file,
          `dead download link "${asset}" — not a downloadable asset in packages/desktop/release-assets.json (known: ${[...downloadableAssets].join(", ")}).`,
        );
      }
    }
  }
}

// ─── Starter count ────────────────────────────────────────────────────────────

export const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
};

/** Markdown emphasis and code ticks may hug either end: `**13** starters`, `_thirteen_ starters`. */
const EMPH = "[*_`]*";
const NUMBER_TOKEN = `\\d+|${Object.keys(NUMBER_WORDS).join("|")}`;

/*
 * The number qualifying "starter(s)" — the NEAREST one, and only that one.
 *
 * Two properties make it right, and the `[A-Za-z]+` capture this replaces had neither:
 *
 *   1. The count is matched FROM NUMBER_WORDS, not from "any word". Leftmost-match on the old
 *      pattern captured the preposition in "one of twelve … starter": "of" is no number, so the
 *      lookup yielded null and a wrong count was skipped in silence through an entire merge.
 *   2. An intervening word may not itself be a number. Without that lookahead "one of thirteen
 *      starters" — a CORRECT claim — matches leftmost at "one" and fails the build for claiming 1.
 *      The lookahead is what makes the nearest number win; the {0,2} window is then a readability
 *      limit rather than the thing holding the pattern together. It stays at 2 deliberately —
 *      widening to 3 starts reading "the step-1 choice on the Starters tab" as a count.
 */
export const STARTER_COUNT_RE = new RegExp(
  `\\b(${NUMBER_TOKEN})\\b${EMPH}` +
    `(?:\\s+${EMPH}(?!(?:${NUMBER_TOKEN})\\b)[A-Za-z][A-Za-z-]*${EMPH}){0,2}` +
    `\\s+${EMPH}starters?\\b`,
  "gi",
);

/** Every starter count claimed on one line. Pure, and the unit the tests drive. */
export function starterCountsIn(line: string): number[] {
  const out: number[] = [];
  // `matchAll` clones the regex, so this shared /g pattern carries no lastIndex between calls.
  for (const match of line.matchAll(STARTER_COUNT_RE)) {
    const token = match[1]!.toLowerCase();
    const n = NUMBER_WORDS[token] ?? (/^\d+$/.test(token) ? Number(token) : null);
    if (n !== null) {
      out.push(n);
    }
  }
  return out;
}

/** Starter-count violations across `files`, as `<file>: <line>: <message>` strings. */
export function starterCountViolations(files: string[], expected: number): string[] {
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const n of starterCountsIn(lines[i]!)) {
        if (n !== expected) {
          found.push(
            `${relative(ROOT, file)}: ${i + 1}: claims ${n} starter(s) but ` +
              `packages/starters/registry.json has ${expected}.`,
          );
        }
      }
    }
  }
  return found;
}

/** The starter ids the templates page renders as cards, in page order. */
export function templatesPageCardSlugs(): string[] {
  const page = readFileSync(join(SITE_PAGES, "templates.md"), "utf8");
  return [...page.matchAll(/^::starter-card\{[^\n]*props\.slug="([^"]+)"/gm)].map((m) => m[1]!);
}

function checkStarterCount(): void {
  /*
   * A count NUMBER_WORDS cannot spell is one `starterCountsIn` reads as null and skips — the same
   * silent-skip failure this pattern was rewritten to close. Fail on the blind spot itself.
   */
  if (!Object.values(NUMBER_WORDS).includes(starterCount)) {
    fail(REGISTRY_PATH, `${starterCount} starters, but NUMBER_WORDS has no word for it.`);
  }
  for (const violation of starterCountViolations(targetFiles(), starterCount)) {
    violations.push(violation);
  }
  /*
   * Set equality, both directions, like scripts/screenshots/shot-paths.test.ts. A missing card is
   * a larger staleness surface than a wrong number and nothing checked it: the page duplicates
   * every starter's name, tagline and accent by hand. Order is deliberately not asserted — the
   * page groups by industry.
   */
  const cards = new Set(templatesPageCardSlugs());
  const ids = new Set(starterIds);
  const missing = starterIds.filter((id) => !cards.has(id));
  const extra = [...cards].filter((slug) => !ids.has(slug));
  if (missing.length > 0) {
    fail(join(SITE_PAGES, "templates.md"), `no ::starter-card for ${missing.join(", ")}.`);
  }
  if (extra.length > 0) {
    fail(
      join(SITE_PAGES, "templates.md"),
      `::starter-card for unknown starter ${extra.join(", ")}.`,
    );
  }
}

// ─── Screenshot refs on site pages ─────────────────────────────────────────────

// Site pages reference the screenshots through the docs content type's asset mount
// (/content/docs/images/…), which is where the build republishes docs/images/.
const SCREENSHOT_RE = /\/content\/docs\/images\/([A-Za-z0-9_-]+)\.(?:png|webp|jpg|jpeg)/g;

function checkScreenshots(): void {
  let manifestNames: Set<string>;
  try {
    const manifest = readJson<{ shots?: { name: string }[] }>(MANIFEST_PATH);
    manifestNames = new Set((manifest.shots ?? []).map((s) => s.name));
  } catch {
    return; // No manifest → nothing to check.
  }
  for (const file of targetFiles()) {
    if (!file.startsWith(SITE_PAGES)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SCREENSHOT_RE)) {
      const name = match[1]!;
      if (!manifestNames.has(name) && !existsSync(join(SCREENSHOTS_DIR, `${name}.png`))) {
        fail(file, `references screenshot "${name}" not produced by the screenshots manifest.`);
      }
    }
  }
}

// ─── README `bun test` fences ──────────────────────────────────────────────────

function checkReadmeBunTest(): void {
  const lines = readFileSync(README, "utf8").split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      continue;
    }
    // Inside a fenced block: a bare `bun test` (not --isolate, not `bun run test…`) is unsupported.
    if (/^\s*bun test\b/.test(line) && !line.includes("--isolate")) {
      fail(
        README,
        `${i + 1}: use "bun test --isolate" (plain "bun test" is unsupported per CLAUDE.md).`,
      );
    }
  }
}

// ─── LICENSE presence ─────────────────────────────────────────────────────────

function checkLicenses(): void {
  if (!existsSync(join(ROOT, "LICENSE"))) {
    fail(join(ROOT, "LICENSE"), "root LICENSE file is missing.");
  }
  const rootPkg = readJson<{ license?: string }>(join(ROOT, "package.json"));
  if (!rootPkg.license) {
    fail(join(ROOT, "package.json"), 'root package.json is missing a "license" field.');
  }
  for (const group of ["packages", "extensions"]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      const pkgPath = join(dir, name, "package.json");
      if (!existsSync(pkgPath)) {
        continue;
      }
      const pkg = readJson<{ private?: boolean }>(pkgPath);
      if (pkg.private) {
        continue;
      }
      if (!existsSync(join(dir, name, "LICENSE"))) {
        fail(join(dir, name), "publishable package is missing a LICENSE file.");
      }
    }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

/*
 * Guarded so the units above can be imported by check-site-claims.test.ts. The module used to run
 * on import, which is why the gate that guards every count in the repo had no test of its own.
 * Mirrors scripts/docs/check-standards.ts.
 */
if (import.meta.main) {
  main();
}

function main(): void {
  lintClaims();
  checkStaleAllow();
  checkDownloadLinks();
  checkStarterCount();
  checkScreenshots();
  checkReadmeBunTest();
  checkLicenses();

  if (violations.length > 0) {
    console.error(`\nsite claims: ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`  ${v}`);
    }
    process.exit(1);
  }
  console.log("site claims: marketing copy, download links, starters, and licenses all check out.");
}
