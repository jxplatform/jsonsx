/*
 * Starters — the catalogue of ready-made starter sites a user can clone when creating a new Jx
 * project (in Studio's New Project modal or via `bun create @jxsuite --template <id>`).
 *
 * This module is metadata-only: it exposes the registry and resolves each starter's on-disk
 * directory. The actual copy-and-rewrite happens in create's generate.ts. Keeping resolution here
 * (relative to `import.meta.dirname`) means it works both from the monorepo and from the published
 * package bundled inside the desktop app.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One entry in {@link registry.json} — everything the picker UI needs to render a template card. */
export interface StarterMeta {
  /** Stable id; also the directory name under `sites/` and the value threaded as `starter`. */
  id: string;
  /** Human-facing display name, e.g. "Bistro & Café". */
  name: string;
  /** Industry archetype label, e.g. "Restaurant & Food". */
  industry: string;
  /** One-line summary shown under the name. */
  tagline: string;
  /** Longer description for the showcase / tooltip. */
  description: string;
  /** Short bullets naming the Jx features the starter demonstrates. */
  features: string[];
  /** Accent colour (hex) — mirrors the site's primary token; used for card theming. */
  accent: string;
  /** Small preview image as a self-contained `data:` URI so the picker needs no extra plumbing. */
  thumbnail: string;
}

const STARTERS_DIR = import.meta.dirname;

/** Absolute path to the directory holding the per-starter project trees. */
export const SITES_DIR = join(STARTERS_DIR, "sites");

let _cache: StarterMeta[] | null = null;

/** Read and cache the starter registry. */
export function listStarters(): StarterMeta[] {
  if (!_cache) {
    const raw = readFileSync(join(STARTERS_DIR, "registry.json"), "utf8");
    _cache = JSON.parse(raw) as StarterMeta[];
  }
  return _cache;
}

/**
 * Look up a single starter's metadata by id.
 *
 * @param {string} id
 * @returns {StarterMeta | undefined}
 */
export function getStarter(id: string): StarterMeta | undefined {
  return listStarters().find((s) => s.id === id);
}

/**
 * Absolute path to a starter's project directory. Throws if the id is unknown, so callers get a
 * clear error rather than copying from a non-existent path.
 *
 * @param {string} id
 * @returns {string}
 */
export function getStarterDir(id: string): string {
  if (!getStarter(id)) {
    throw new Error(`Unknown starter: "${id}"`);
  }
  return join(SITES_DIR, id);
}
