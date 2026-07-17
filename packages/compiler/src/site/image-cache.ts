/**
 * Image-cache.js — Content-hash based cache for processed image variants.
 *
 * Stores a manifest of previously processed images so that unchanged sources can skip re-encoding
 * on subsequent builds. Cache lives in the npm global cache directory under jxsuite-images/ so that
 * CI environments (e.g. Cloudflare Pages) can persist it via their npm cache layer.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { configHash, contentHash } from "./image-optimizer.ts";

import type { ImageConfig, ImageManifest } from "./image-optimizer.ts";

interface CacheEntry {
  source: string; // Relative path to source image
  manifest: ImageManifest; // Processed image manifest
  timestamp: number; // When the entry was cached
}

export interface CacheManifest {
  version: number; // Cache format version
  entries: Record<string, CacheEntry>; // Cached entries keyed by content+config hash
  touched?: Set<string>; // Keys resolved during this build — runtime only, never serialized
}

// ─── Cache directory resolution ──────────────────────────────────────────────

let _npmCacheBase: string | null | undefined; // Undefined = not yet resolved

/** Reset the memoized npm cache base so the next call re-evaluates. Tests only. */
export function _testResetNpmCacheBase() {
  _npmCacheBase = undefined;
}

/**
 * Directly set the memoized npm cache base. Pass null to force the project-local fallback. Tests
 * only.
 */
export function _testSetNpmCacheBase(value: string | null) {
  _npmCacheBase = value;
}

/**
 * Return the image cache directory for a project.
 *
 * Prefers the npm global cache (`npm config get cache`) so CI environments that cache ~/.npm (e.g.
 * Cloudflare Pages) automatically persist optimized images across builds. Falls back to
 * .cache/images inside the project root when npm is unavailable.
 *
 * Result is memoized — `npm config get cache` is only spawned once per process.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function getImageCacheDir(projectRoot: string): string {
  if (_npmCacheBase === undefined) {
    try {
      const result = execSync("npm config get cache", {
        cwd: tmpdir(), // Avoid ENOWORKSPACES when cwd is inside an npm workspace
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      _npmCacheBase = result && result !== "undefined" ? result : null;
    } catch {
      _npmCacheBase = null;
    }
  }
  if (_npmCacheBase) {
    return resolve(_npmCacheBase, "jxsuite-images", basename(projectRoot));
  }
  return resolve(projectRoot, ".cache/images");
}

// ─── Cache key ───────────────────────────────────────────────────────────────

/**
 * Build a cache key from source file content and config.
 *
 * @param {string} srcPath - Absolute path to source image
 * @param {ImageConfig} config
 * @returns {string}
 */
export function cacheKey(srcPath: string, config: ImageConfig) {
  return `${contentHash(srcPath)}:${configHash(config)}`;
}

// ─── Load / save ─────────────────────────────────────────────────────────────

/**
 * Load the cache manifest from disk, or return an empty one.
 *
 * @param {string} projectRoot
 * @returns {CacheManifest}
 */
export function loadCache(projectRoot: string): CacheManifest {
  const manifestPath = resolve(getImageCacheDir(projectRoot), "manifest.json");
  if (!existsSync(manifestPath)) {
    return { entries: {}, touched: new Set(), version: 1 };
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as CacheManifest;
    parsed.touched = new Set();
    return parsed;
  } catch {
    return { entries: {}, touched: new Set(), version: 1 };
  }
}

/**
 * Save the cache manifest to disk.
 *
 * With `prune: true`, entries whose key was never touched during this build (deleted/replaced
 * sources, superseded configs) are dropped and their variant files deleted first, so a persisted
 * cache — and the dist copy made from it — stays bounded to images the build actually uses.
 *
 * @param {string} projectRoot
 * @param {CacheManifest} cache
 * @param {{ prune?: boolean }} [options]
 */
export function saveCache(
  projectRoot: string,
  cache: CacheManifest,
  options: { prune?: boolean } = {},
) {
  if (options.prune && cache.touched) {
    pruneStale(cache, cache.touched);
  }
  const cacheDir = getImageCacheDir(projectRoot);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    resolve(cacheDir, "manifest.json"),
    JSON.stringify({ entries: cache.entries, version: cache.version }, null, 2),
    "utf8",
  );
}

/**
 * Remove entries (and their variant files) that were not touched during this build. A file shared
 * with a surviving entry is kept — the same source under an older config produces overlapping
 * width/format filenames, so deleting blindly would remove files a live entry still references.
 *
 * @param {CacheManifest} cache
 * @param {Set<string>} touched
 */
function pruneStale(cache: CacheManifest, touched: Set<string>) {
  const keep = new Set<string>();
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (touched.has(key)) {
      for (const variant of entry.manifest.variants ?? []) {
        keep.add(variant.absolutePath);
      }
    }
  }
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (touched.has(key)) {
      continue;
    }
    for (const variant of entry.manifest.variants ?? []) {
      if (!keep.has(variant.absolutePath)) {
        rmSync(variant.absolutePath, { force: true });
      }
    }
    delete cache.entries[key];
  }
}

// ─── Entry access ─────────────────────────────────────────────────────────────

/**
 * Check if a cache entry exists and its output files are still present.
 *
 * @param {CacheManifest} cache
 * @param {string} key
 * @returns {ImageManifest | null}
 */
export function getCached(cache: CacheManifest, key: string) {
  cache.touched?.add(key);
  const entry = cache.entries[key];
  if (!entry) {
    return null;
  }
  return entry.manifest;
}

/**
 * Store a processed result in the cache.
 *
 * @param {CacheManifest} cache
 * @param {string} key
 * @param {string} sourcePath - Relative source path for reference
 * @param {ImageManifest} manifest
 */
export function setCached(
  cache: CacheManifest,
  key: string,
  sourcePath: string,
  manifest: ImageManifest,
) {
  cache.touched?.add(key);
  cache.entries[key] = {
    manifest,
    source: sourcePath,
    timestamp: Date.now(),
  };
}
