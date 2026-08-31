#!/usr/bin/env bun
/**
 * Check-extension-catalog.ts — `packages/extension-catalog/catalog.json` is what its generator
 * produces from the `extensions/` tree.
 *
 * The catalogue is the list of first-party extensions Studio advertises as "available", and every
 * byte of it is derived: each package's own `jx-extension.json` supplies the identity, the class
 * descriptors it names supply the project sections and file formats, and its `package.json`
 * supplies the intra-extension `requires` edges. Nobody authors it, so the policy is the schema
 * policy — a generator produces the bytes and a human reviews the meaning.
 *
 *     bun run catalog:verify   # the gate: regenerate, report drift, restore nothing, exit 1
 *     bun run catalog:sync     # regenerate and KEEP the result, exit 0 — the fixer
 *
 * WHY THIS IS ITS OWN GATE. `check-schema-freshness.ts` derives its file set from every tracked
 * `*schema.json`, and this artifact is not one — it would pass unseen there forever. Reporting is
 * shared rather than reimplemented: the drift is rendered as the JSON Pointers that moved, using
 * that script's own `pointerDelta`.
 *
 * WHY IT READS PATHS, NEVER SPECIFIERS. Core may not depend on an extension (specs/extensions.md
 * §2). This script opens `extensions/<name>/jx-extension.json` as a FILE and imports nothing, so
 * the rule holds structurally rather than by exemption — and `scripts/` is outside the tree
 * `check-dep-rules.ts` walks in any case.
 *
 * It also enforces, across the whole tree at once, the three things each extension's own
 * `tests/extension-manifest.test.ts` asserts for itself: the manifest name matches `package.json`,
 * `"jx"` points at the manifest, and `exports["./jx-extension.json"]` is present. That last one is
 * load-bearing rather than tidy — it is the only path by which a host resolves the manifest, so a
 * package missing it is one the registry cannot load at all.
 *
 * @docs extending/contributing/monorepo
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deltaSize, pointerDelta } from "./check-schema-freshness.ts";
import { headingsOf } from "./docs/lib/headings.ts";

/** Where the extension packages live, relative to the repo root. */
const EXTENSIONS_DIR = "extensions";

/** The committed artifact this script owns. */
export const CATALOG_PATH = "packages/extension-catalog/catalog.json";

/** The well-known manifest filename, mirroring `@jxsuite/schema`'s `EXTENSION_MANIFEST`. */
const MANIFEST = "jx-extension.json";

/** Docs page every catalogue entry deep-links into, and the slug it publishes under. */
const DOCS_PAGE = "docs/extending/extensions/first-party.md";
const DOCS_SLUG = "extending/extensions/first-party";

interface CatalogSection {
  key: string;
  title?: string;
}

export interface ExtensionCatalogMeta {
  name: string;
  title: string;
  description: string;
  sections: CatalogSection[];
  formats?: string[];
  requires?: string[];
  docs: string;
}

interface Manifest {
  name?: string;
  title?: string;
  description?: string;
  classes?: Record<string, string>;
}

interface PackageJson {
  name?: string;
  jx?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
}

/** Read and parse a JSON file, naming the file in any failure. */
function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/**
 * The published deep link for one extension, read from the docs page rather than guessed.
 *
 * The anchor is `slugifyHeading` applied to a heading's RENDERED text, so it cannot be derived from
 * a package name — `@jxsuite/parser: content and Markdown` publishes
 * `jxsuiteparser-content-and-markdown`. Finding the heading instead means two things: the link is
 * right by construction, and an extension the page never documents fails this gate by name. That
 * second property is the point. `@jxsuite/feed` shipped and the page still said "Four".
 *
 * @param {Map<string, string>} anchors - Heading slug by the package name it opens with
 * @param {string} name - Package name
 * @returns {string}
 */
function docsLink(anchors: Map<string, string>, name: string): string {
  const anchor = anchors.get(name);
  if (anchor === undefined) {
    throw new Error(
      `${DOCS_PAGE} documents no section for "${name}" — every catalogue entry deep-links to its ` +
        `own heading, so add a "## ${name}: <what it does>" section (and update the page's count ` +
        `and its \`code:\` frontmatter) before this extension can be advertised`,
    );
  }
  return `/docs/${DOCS_SLUG}#${anchor}`;
}

/**
 * Heading slug by the package name its text opens with, for every `##` on the first-party page.
 *
 * @param {string} root - Repo root
 * @returns {Map<string, string>}
 */
function docsAnchors(root: string): Map<string, string> {
  const path = resolve(root, DOCS_PAGE);
  if (!existsSync(path)) {
    throw new Error(`${DOCS_PAGE} does not exist — every catalogue entry links to it`);
  }
  const anchors = new Map<string, string>();
  for (const heading of headingsOf(readFileSync(path, "utf8"))) {
    const match = /^(@[a-z\d][\w.-]*\/[a-z\d][\w.-]*)\b/.exec(heading.text);
    if (heading.depth === 2 && match?.[1]) {
      anchors.set(match[1], heading.slug);
    }
  }
  return anchors;
}

/**
 * Build the catalogue from the `extensions/` tree.
 *
 * Pure over `root`: it reads files and returns data, so a test can point it at a fixture tree.
 *
 * @param {string} root - Repo root
 * @returns {ExtensionCatalogMeta[]} Entries sorted by package name
 */
export function buildCatalog(root = "."): ExtensionCatalogMeta[] {
  const extensionsRoot = resolve(root, EXTENSIONS_DIR);
  if (!existsSync(extensionsRoot)) {
    throw new Error(`No ${EXTENSIONS_DIR}/ directory at ${extensionsRoot}`);
  }
  const anchors = docsAnchors(root);
  const dirs = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  // First pass: identity, so `requires` can be filtered to catalogue members in the second.
  const built: { entry: ExtensionCatalogMeta; deps: string[] }[] = [];
  for (const dir of dirs) {
    const packagePath = join(extensionsRoot, dir, "package.json");
    const manifestPath = join(extensionsRoot, dir, MANIFEST);
    if (!existsSync(manifestPath) || !existsSync(packagePath)) {
      continue;
    }
    const pkg = readJson<PackageJson>(packagePath);
    const manifest = readJson<Manifest>(manifestPath);

    if (typeof manifest.name !== "string") {
      throw new TypeError(`${manifestPath}: must declare a string "name"`);
    }
    if (manifest.name !== pkg.name) {
      throw new Error(
        `${manifestPath}: manifest name "${manifest.name}" does not match package.json "${pkg.name}"`,
      );
    }
    if (pkg.jx !== `./${MANIFEST}`) {
      throw new Error(
        `${packagePath}: must declare "jx": "./${MANIFEST}" (found ${JSON.stringify(pkg.jx)})`,
      );
    }
    if (!pkg.exports?.[`./${MANIFEST}`]) {
      throw new Error(
        `${packagePath}: exports must include "./${MANIFEST}" — it is the only path by which a ` +
          `host resolves the manifest, so without it the extension cannot be enabled at all`,
      );
    }
    if (typeof manifest.title !== "string" || typeof manifest.description !== "string") {
      throw new TypeError(
        `${manifestPath}: must declare a "title" and a "description" for studio surfaces`,
      );
    }

    const sections: CatalogSection[] = [];
    const formats = new Set<string>();
    for (const ref of Object.values(manifest.classes ?? {})) {
      const classPath = resolve(join(extensionsRoot, dir), ref);
      if (!existsSync(classPath)) {
        throw new Error(`${manifestPath}: class descriptor ${ref} does not exist at ${classPath}`);
      }
      const descriptor = readJson<{
        project?: { key?: string; title?: string };
        format?: { extensions?: string[] };
      }>(classPath);
      const key = descriptor.project?.key;
      if (typeof key === "string") {
        const title = descriptor.project?.title;
        sections.push({ key, ...(typeof title === "string" ? { title } : {}) });
      }
      for (const ext of descriptor.format?.extensions ?? []) {
        formats.add(ext);
      }
    }

    built.push({
      deps: Object.keys(pkg.dependencies ?? {}),
      entry: {
        description: manifest.description,
        docs: docsLink(anchors, manifest.name),
        name: manifest.name,
        sections,
        title: manifest.title,
        ...(formats.size > 0 ? { formats: [...formats].toSorted() } : {}),
      },
    });
  }

  const members = new Set(built.map((b) => b.entry.name));
  const catalog: ExtensionCatalogMeta[] = [];
  for (const { deps, entry } of built) {
    const requires = deps.filter((dep) => members.has(dep)).toSorted();
    if (requires.length > 0) {
      entry.requires = requires;
    }
    catalog.push(entry);
  }

  // Two extensions claiming one section key is a registry error at load time (§3.1). Catching it
  // Here turns "the user's project fails to open" into "the pull request is red".
  const owner = new Map<string, string>();
  for (const entry of catalog) {
    for (const { key } of entry.sections) {
      const previous = owner.get(key);
      if (previous !== undefined) {
        throw new Error(`Section key "${key}" is claimed by both ${previous} and ${entry.name}`);
      }
      owner.set(key, entry.name);
    }
  }

  return catalog.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Serialise the catalogue exactly as the committed file holds it (trailing newline included). */
export function serializeCatalog(catalog: ExtensionCatalogMeta[]): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

async function main(): Promise<void> {
  const fix = process.argv.includes("--fix");
  const root = resolve(import.meta.dirname, "..");
  const target = resolve(root, CATALOG_PATH);

  const catalog = buildCatalog(root);
  const generated = serializeCatalog(catalog);
  const committed = existsSync(target) ? readFileSync(target, "utf8") : null;

  if (committed === generated) {
    console.log(`✓ ${CATALOG_PATH} is up to date (${catalog.length} extensions)`);
    return;
  }

  const delta = pointerDelta(committed === null ? [] : (JSON.parse(committed) as unknown), catalog);

  if (fix) {
    writeFileSync(target, generated);
    console.log(
      `✓ wrote ${CATALOG_PATH} (${catalog.length} extensions, ${deltaSize(delta)} pointers moved)`,
    );
    for (const line of [
      ...delta.added.map((p) => `  + ${p}`),
      ...delta.removed.map((p) => `  - ${p}`),
      ...delta.changed.map((p) => `  ~ ${p}`),
    ]) {
      console.log(line);
    }
    return;
  }

  if (deltaSize(delta) === 0) {
    /*
     * Same content, different bytes: something other than the generator rewrote the file. That is
     * a second writer on one artifact, and the fix is to stop it rather than to regenerate — which
     * is why `.oxfmtrc.json` ignores this path, exactly as it ignores the generated schemas.
     */
    console.error(
      `✗ ${CATALOG_PATH} has the right CONTENT but not the generator's bytes.\n\n` +
        `  Something reformatted it. Check that the path is still ignored by .oxfmtrc.json, ` +
        `then run \`bun run catalog:sync\`.`,
    );
    process.exitCode = 1;
    return;
  }

  console.error(`✗ ${CATALOG_PATH} is stale — ${deltaSize(delta)} pointer(s) moved:\n`);
  for (const pointer of delta.added) {
    console.error(`  + ${pointer}`);
  }
  for (const pointer of delta.removed) {
    console.error(`  - ${pointer}`);
  }
  for (const pointer of delta.changed) {
    console.error(`  ~ ${pointer}`);
  }
  console.error(`\nRun \`bun run catalog:sync\` and commit the result.`);
  process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
