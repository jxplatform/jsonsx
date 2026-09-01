/*
 * Extension catalogue — the first-party Jx extensions a project can turn on, as data.
 *
 * This module is metadata-only, and deliberately so: it names `@jxsuite/parser` and its four
 * siblings without importing any of them, so core never gains a dependency edge on `extensions/*`
 * (specs/extensions.md §2, enforced by scripts/check-dep-rules.ts).
 *
 * `catalog.json` is a BUILD OUTPUT, generated from every `extensions/<name>/jx-extension.json` and
 * the class descriptors it points at. `bun run catalog:verify` is the gate and `bun run
 * catalog:sync` is the fixer; never hand-edit it, because the next sync overwrites the edit.
 *
 * ## What is NOT here, and why
 *
 * **No version, and no semver range.** `packages/studio/src/settings/dependencies-editor.ts`
 * records what that costs: `@jxsuite/*` rows once targeted the version the Studio build embedded,
 * which "proposed a version that may never have been published, for a package whose real latest
 * the table had not looked at". The five extensions release on five independent cadences, and a
 * catalogue frozen inside a packaged desktop app is strictly worse than the bug already fixed —
 * it is read months after it was written, and release-please writes a version into package.json
 * before npm publish completes, so a pinned range here can name a version that never shipped.
 * `addPackage(name)` already means "latest", resolved at install time. A test asserts this
 * absence by name.
 *
 * **No `bundled`, `installed`, `source` or `problem`.** Those are per-host or per-project facts,
 * answered by whichever backend serves the catalogue — which is the whole reason the catalogue is
 * a platform capability rather than a constant. A Worker ships a fixed set of extension packages
 * (specs/extensions.md §5.5), and a desktop build ships another; neither is knowable from here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One project.json section an extension's classes claim (specs/extensions.md §9). */
export interface CatalogSection {
  /** The project.json top-level property, e.g. "content". */
  key: string;
  /** The owning class's `project.title`, e.g. "Content Types". */
  title?: string;
}

/** One first-party extension, as the generator derives it from the package's own manifest. */
export interface ExtensionCatalogMeta {
  /** Package name — the identity, the project.json entry, and the `bun add` argument. */
  name: string;
  /** Manifest `title`, for studio surfaces. */
  title: string;
  /** Manifest `description`, one line. */
  description: string;
  /** The project.json sections enabling it makes legal, in class declaration order. */
  sections: CatalogSection[];
  /** File extensions its format classes claim (".md", ".csv"), when it claims any. */
  formats?: string[];
  /** Other catalogue members it depends on — auth needs connector. */
  requires?: string[];
  /** Documentation page for this extension. */
  docs: string;
}

const CATALOG_DIR = import.meta.dirname;

let _cache: ExtensionCatalogMeta[] | null = null;

/**
 * Read and cache the shipped catalogue.
 *
 * @returns {ExtensionCatalogMeta[]}
 */
export function listCatalog(): ExtensionCatalogMeta[] {
  if (!_cache) {
    const raw = readFileSync(join(CATALOG_DIR, "catalog.json"), "utf8");
    _cache = JSON.parse(raw) as ExtensionCatalogMeta[];
  }
  return _cache;
}

/**
 * One entry by package name, or `undefined`.
 *
 * @param {string} name
 * @returns {ExtensionCatalogMeta | undefined}
 */
export function getCatalogEntry(name: string): ExtensionCatalogMeta | undefined {
  return listCatalog().find((entry) => entry.name === name);
}
