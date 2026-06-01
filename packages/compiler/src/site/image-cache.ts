/**
 * Image-cache.js — Content-hash based cache for processed image variants.
 *
 * Stores a manifest of previously processed images so that unchanged sources can skip re-encoding
 * on subsequent builds. Cache lives in .jx-cache/images/.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { contentHash, configHash } from "./image-optimizer";

import type { ImageManifest } from "./image-optimizer";
import type { ImageConfig } from "./image-optimizer";

interface CacheEntry {
  source: string; // Relative path to source image
  manifest: ImageManifest; // Processed image manifest
  timestamp: number; // When the entry was cached
}

export interface CacheManifest {
  version: number; // Cache format version
  entries: Record<string, CacheEntry>; // Cached entries keyed by content+config hash
}

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

/**
 * Load the cache manifest from disk, or return an empty one.
 *
 * @param {string} projectRoot
 * @returns {CacheManifest}
 */
export function loadCache(projectRoot: string) {
  const manifestPath = resolve(projectRoot, ".jx-cache/images/manifest.json");
  if (!existsSync(manifestPath)) {
    return { version: 1, entries: {} };
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { version: 1, entries: {} };
  }
}

/**
 * Save the cache manifest to disk.
 *
 * @param {string} projectRoot
 * @param {CacheManifest} cache
 */
export function saveCache(projectRoot: string, cache: CacheManifest) {
  const cacheDir = resolve(projectRoot, ".jx-cache/images");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(resolve(cacheDir, "manifest.json"), JSON.stringify(cache, null, 2), "utf8");
}

/**
 * Check if a cache entry exists and its output files are still present.
 *
 * @param {CacheManifest} cache
 * @param {string} key
 * @returns {ImageManifest | null}
 */
export function getCached(cache: CacheManifest, key: string) {
  const entry = cache.entries[key];
  if (!entry) return null;
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
  cache.entries[key] = {
    source: sourcePath,
    manifest,
    timestamp: Date.now(),
  };
}
