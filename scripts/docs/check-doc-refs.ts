// Validates the associations between /docs pages, specs/, code, screenshots, and
// The nav manifest. Fails (exit 1) on any violation so CI keeps the three layers
// (specs ↔ code ↔ user docs) from drifting apart. Companion to the tag conventions
// In tsdoc.json: `@docs <docs-page-slug>` tags in code are validated in reverse.
//
// Usage: bun scripts/docs/check-doc-refs.ts
//
// Forward (docs → sources):
//   - frontmatter: `title` required; `description` required, ≤155 chars
//   - `spec:` entries (`spec.md#19.4` or `site-architecture.md`) must name a real
//     Spec file and a real numbered heading in it
//   - `code:` entries must be repo paths that exist
//   - Body image refs must be page-relative paths into docs/images/ (so the page
//     Renders in any markdown editor), be produced by the screenshots manifest,
//     AND exist on disk
//   - `generated: true` pages must carry the generator banner
//   - Nav bijection: every docs page appears exactly once in docs/nav.json and
//     Every nav path has a page
// Reverse (code → docs):
//   - `@docs <slug>` tags in packages/*/src and extensions/*/src must resolve to
//     A real docs page

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const DOCS_DIR = join(ROOT, "docs");
const SPECS_DIR = join(ROOT, "specs");
const SCREENSHOTS_DIR = join(ROOT, "docs/images");
const MANIFEST_PATH = join(ROOT, "scripts/screenshots/manifest.json");
const NAV_PATH = join(DOCS_DIR, "nav.json");

const MAX_DESCRIPTION = 155;
const GENERATED_BANNER = "<!-- GENERATED";

const violations: string[] = [];

/** Record a violation with its originating file. */
function fail(file: string, message: string) {
  violations.push(`${relative(ROOT, file)}: ${message}`);
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

interface DocFrontmatter {
  title?: unknown;
  description?: unknown;
  spec?: unknown;
  code?: unknown;
  generated?: unknown;
}

/** Parse the leading YAML frontmatter block of a markdown source, or null. */
function parseFrontmatter(source: string): DocFrontmatter | null {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    return null;
  }
  try {
    return Bun.YAML.parse(match[1]!) as DocFrontmatter;
  } catch {
    return null;
  }
}

// ─── Spec heading index ──────────────────────────────────────────────────────

/** Numbered headings like `### 19.4a Aggregate Operators` → "19.4a". */
const HEADING_RE = /^#{2,6}\s+(\d+(?:\.\d+)*[a-z]?)\b/gm;

const specSections = new Map<string, Set<string>>();

/** Lazy-load the set of numbered section anchors for a spec file. */
function sectionsOf(specFile: string): Set<string> | null {
  const cached = specSections.get(specFile);
  if (cached) {
    return cached;
  }
  const path = join(SPECS_DIR, specFile);
  if (!existsSync(path)) {
    return null;
  }
  const text = readFileSync(path, "utf8");
  const sections = new Set<string>();
  for (const m of text.matchAll(HEADING_RE)) {
    sections.add(m[1]!);
  }
  specSections.set(specFile, sections);
  return sections;
}

// ─── Screenshot manifest names ───────────────────────────────────────────────

interface ManifestShot {
  name: string;
  docs?: string[];
  regions?: { name: string }[];
  variants?: { suffix: string }[];
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { shots: ManifestShot[] };

/** Image basenames one shot can produce (primary + regions + variants). */
function shotImageNames(shot: ManifestShot): Set<string> {
  const names = new Set<string>([shot.name]);
  for (const region of shot.regions ?? []) {
    names.add(region.name);
  }
  for (const variant of shot.variants ?? []) {
    names.add(`${shot.name}${variant.suffix}`);
  }
  return names;
}

/** Every image basename the screenshots pipeline can produce. */
function manifestImageNames(): Set<string> {
  const names = new Set<string>();
  for (const shot of manifest.shots) {
    for (const name of shotImageNames(shot)) {
      names.add(name);
    }
  }
  return names;
}

// ─── Docs slug derivation (mirrors the parser's deriveSlug) ──────────────────

/** Slug for a docs file: path-based below the root, basename at the root, /index stripped. */
function docSlug(file: string): string {
  const rel = relative(DOCS_DIR, file).replaceAll("\\", "/");
  let slug = rel.slice(0, rel.length - extname(rel).length);
  if (slug.endsWith("/index")) {
    slug = slug.slice(0, -"/index".length);
  }
  return slug;
}

/** True when a docs page exists for a slug (either `<slug>.md` or `<slug>/index.md`). */
function docPageExists(slug: string): boolean {
  return existsSync(join(DOCS_DIR, `${slug}.md`)) || existsSync(join(DOCS_DIR, slug, "index.md"));
}

// ─── Forward checks ──────────────────────────────────────────────────────────

const screenshotNames = manifestImageNames();
const referencedScreenshots = new Set<string>();
// Markdown image targets: any page-relative path, so a ref pointing somewhere other than
// Docs/images/ is caught below rather than skipped silently.
const IMAGE_RE = /!\[[^\]]*]\(<?([^)>\s]+\.(?:png|webp|jpg|jpeg))>?\s*(?:"[^"]*")?\)/g;

/** Drop fenced blocks and inline code spans — image syntax quoted as an example is prose. */
function withoutCode(source: string): string {
  return source.replaceAll(/```[\s\S]*?```/g, "").replaceAll(/`[^`\n]*`/g, "");
}

const docFiles = [...new Bun.Glob("**/*.md").scanSync({ cwd: DOCS_DIR })]
  .map((f) => join(DOCS_DIR, f))
  .toSorted();

for (const file of docFiles) {
  const source = readFileSync(file, "utf8");
  const fm = parseFrontmatter(source);

  if (!fm) {
    fail(file, "missing or unparseable YAML frontmatter");
    continue;
  }
  if (typeof fm.title !== "string" || fm.title.length === 0) {
    fail(file, 'frontmatter "title" is required');
  }
  if (typeof fm.description !== "string" || fm.description.length === 0) {
    fail(file, 'frontmatter "description" is required');
  } else if (fm.description.length > MAX_DESCRIPTION) {
    fail(file, `description is ${fm.description.length} chars (max ${MAX_DESCRIPTION})`);
  }

  if (fm.spec !== undefined) {
    const specs = Array.isArray(fm.spec) ? fm.spec : [fm.spec];
    for (const entry of specs) {
      if (typeof entry !== "string") {
        fail(file, `spec entry is not a string: ${JSON.stringify(entry)}`);
        continue;
      }
      const [specFile, anchor] = entry.split("#") as [string, string | undefined];
      const sections = sectionsOf(specFile);
      if (!sections) {
        fail(file, `spec file not found: specs/${specFile}`);
        continue;
      }
      if (anchor && !sections.has(anchor)) {
        fail(file, `spec section not found: specs/${specFile} §${anchor}`);
      }
    }
  }

  if (fm.code !== undefined) {
    const codes = Array.isArray(fm.code) ? fm.code : [fm.code];
    for (const entry of codes) {
      if (typeof entry !== "string") {
        fail(file, `code entry is not a string: ${JSON.stringify(entry)}`);
        continue;
      }
      if (!existsSync(join(ROOT, entry))) {
        fail(file, `code path not found: ${entry}`);
      }
    }
  }

  for (const m of withoutCode(source).matchAll(IMAGE_RE)) {
    const target = m[1]!;
    // Images are addressed relative to the page so /docs reads correctly in a markdown editor;
    // The compiler republishes them under /content/docs/ when the site builds.
    if (target.startsWith("/") || /^[a-z][\w+.-]*:/i.test(target)) {
      fail(file, `image ref must be page-relative into docs/images/: ${target}`);
      continue;
    }
    const resolved = resolve(dirname(file), target);
    if (dirname(resolved) !== SCREENSHOTS_DIR) {
      fail(file, `image ref must resolve into docs/images/: ${target}`);
      continue;
    }
    const name = basename(resolved, extname(resolved));
    referencedScreenshots.add(name);
    if (!screenshotNames.has(name)) {
      fail(file, `screenshot "${name}" is not produced by scripts/screenshots/manifest.json`);
    }
    if (!existsSync(resolved)) {
      fail(file, `screenshot file missing on disk: docs/images/${basename(resolved)}`);
    }
  }

  if (fm.generated === true && !source.includes(GENERATED_BANNER)) {
    fail(file, `generated page lacks the "${GENERATED_BANNER}" banner`);
  }
}

// ─── Nav bijection ───────────────────────────────────────────────────────────

interface NavNode {
  path: string;
  label: string;
  children?: NavNode[];
}

const nav = JSON.parse(readFileSync(NAV_PATH, "utf8")) as { sections: NavNode[] };
const navPaths: string[] = [];
for (const section of nav.sections) {
  navPaths.push(section.path);
  for (const child of section.children ?? []) {
    navPaths.push(child.path);
  }
}

const navPathSet = new Set<string>();
for (const path of navPaths) {
  if (navPathSet.has(path)) {
    fail(NAV_PATH, `nav path appears more than once: ${path}`);
  }
  navPathSet.add(path);
  if (!docPageExists(path)) {
    fail(NAV_PATH, `nav path has no docs page: ${path}`);
  }
}

for (const file of docFiles) {
  const slug = docSlug(file);
  if (!navPathSet.has(slug)) {
    fail(file, `docs page missing from docs/nav.json: ${slug}`);
  }
}

// ─── Reverse: @docs tags in code ─────────────────────────────────────────────

const DOCS_TAG_RE = /@docs\s+([A-Za-z0-9/_-]+)/g;
const CODE_GLOBS = ["packages/*/src/**/*.ts", "extensions/*/src/**/*.ts"];

for (const pattern of CODE_GLOBS) {
  for (const rel of new Bun.Glob(pattern).scanSync({ cwd: ROOT })) {
    const file = join(ROOT, rel);
    const source = readFileSync(file, "utf8");
    if (!source.includes("@docs")) {
      continue;
    }
    for (const m of source.matchAll(DOCS_TAG_RE)) {
      const slug = m[1]!;
      if (!docPageExists(slug)) {
        const line = source.slice(0, m.index).split("\n").length;
        fail(file, `line ${line}: @docs target has no docs page: ${slug}`);
      }
    }
  }
}

// ─── Screenshot coverage (warnings, not violations) ──────────────────────────
// A shot whose images no docs page references needs a `docs` field: either the
// Slugs it will illustrate, or [] to mark it as serving the README/marketing.

const warnings: string[] = [];
for (const shot of manifest.shots) {
  const referenced = [...shotImageNames(shot)].some((name) => referencedScreenshots.has(name));
  if (!referenced && shot.docs === undefined) {
    warnings.push(
      `manifest shot "${shot.name}" is referenced by no docs page and has no "docs" field`,
    );
  }
  for (const slug of shot.docs ?? []) {
    if (!docPageExists(slug)) {
      fail(MANIFEST_PATH, `shot "${shot.name}" docs entry has no docs page: ${slug}`);
    }
  }
}
if (warnings.length > 0) {
  console.warn(`docs check: ${warnings.length} warning(s):`);
  for (const w of warnings) {
    console.warn(`  ${w}`);
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

if (violations.length > 0) {
  console.error(`docs check: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  process.exit(1);
}
console.log(`docs check: ${docFiles.length} page(s), nav, specs, code, and screenshots all agree.`);
