/**
 * Image-transform.js — Document tree walker for responsive image optimization.
 *
 * Walks a Jx document tree, finds <img> nodes with static src paths, and injects srcset, sizes,
 * width, height, loading, and decoding attributes. Collects image references so the build
 * orchestrator knows which files to process.
 */

import { existsSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import {
  processImage,
  buildSrcset,
  contentHash,
  configHash,
  getImageMetadata,
} from "./image-optimizer.ts";
import { getCached, setCached, getImageCacheDir } from "./image-cache.ts";

import type { ImageConfig } from "./image-optimizer.ts";
import type { ImageManifest } from "./image-optimizer.ts";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CacheManifest } from "./image-cache.ts";
import type { JxDocument } from "@jxsuite/schema/types";

const SKIP_EXTENSIONS = new Set([".svg", ".gif"]);
const EXTERNAL_PREFIXES = ["http://", "https://", "data:", "//"];

/** Per-build memo of original image dimensions + content hash (cloudflare mode). */
export type ImageMetaCache = Map<string, { width: number; height: number; hash: string }>;

/**
 * Resolve original image dimensions and content hash for cloudflare mode. Reads only the image
 * header via Sharp — no variants are generated.
 *
 * @param {string} absoluteSrc
 * @param {ImageMetaCache} metaCache
 * @returns {Promise<{ width: number; height: number; hash: string }>}
 */
async function resolveCfMeta(absoluteSrc: string, metaCache: ImageMetaCache) {
  let meta = metaCache.get(absoluteSrc);
  if (!meta) {
    const m = await getImageMetadata(absoluteSrc);
    meta = { width: m.width, height: m.height, hash: contentHash(absoluteSrc) };
    metaCache.set(absoluteSrc, meta);
  }
  return meta;
}

/**
 * Build a srcset of `/_jx/image` endpoint URLs for the configured widths that fit within the
 * original image width. The `v` param carries the content hash for cache busting.
 *
 * @param {string} src - Original site-relative src (e.g. "/images/hero.png")
 * @param {number[]} widths
 * @param {number} originalWidth
 * @param {string} hash - 8-char content hash
 * @returns {string}
 */
function buildCloudflareSrcset(src: string, widths: number[], originalWidth: number, hash: string) {
  return widths
    .filter((w) => w <= originalWidth)
    .sort((a, b) => a - b)
    .map((w) => `/_jx/image?src=${encodeURIComponent(src)}&w=${w}&v=${hash} ${w}w`)
    .join(", ");
}

/**
 * @param {string} absoluteSrc
 * @param {string} src
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {CacheManifest} cache
 * @returns {Promise<ImageManifest>}
 */
async function resolveManifest(
  absoluteSrc: string,
  src: string,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest,
) {
  const key = `${contentHash(absoluteSrc)}:${configHash(config)}`;
  const cached = getCached(cache, key);

  if (cached) {
    const allExist = cached.variants.every((v) => existsSync(v.absolutePath));
    if (allExist) return cached;
  }

  if (!cached) console.log(`    Optimizing ${basename(absoluteSrc)}...`);
  const manifest = await processImage(absoluteSrc, getImageCacheDir(projectRoot), config);
  setCached(cache, key, src, manifest);
  return manifest;
}

/**
 * Check if a src value should be skipped for optimization.
 *
 * @param {string} src
 * @returns {boolean}
 */
function shouldSkip(src: string) {
  if (typeof src !== "string") return true;
  if (!src) return true;
  if (src.includes("${")) return true;
  if (EXTERNAL_PREFIXES.some((p) => src.startsWith(p))) return true;
  if (SKIP_EXTENSIONS.has(extname(src).toLowerCase())) return true;
  return false;
}

/**
 * Resolve a src path to an absolute filesystem path.
 *
 * Handles paths starting with "/" (relative to public dir or project root).
 *
 * @param {string} src
 * @param {string} projectRoot
 * @returns {string}
 */
function resolveImagePath(src: string, projectRoot: string) {
  if (src.startsWith("/")) {
    return resolve(projectRoot, "public", src.slice(1));
  }
  return resolve(projectRoot, src);
}

/**
 * Transform image nodes in a Jx document tree.
 *
 * Mutates img nodes in place, injecting srcset, sizes, width, height, loading, and decoding.
 * Optimized variants are written to .cache/images/_optimized/ — the caller is responsible for
 * copying them to the dist directory after all pages are compiled.
 *
 * @param {JxMutableNode | JxDocument} doc - The Jx document tree (mutated in place)
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {CacheManifest | null} cache - Variant cache (build mode); unused in cloudflare mode
 * @param {ImageMetaCache} [metaCache] - Dimension/hash memo (cloudflare mode)
 * @returns {Promise<{ imageRefs: Map<string, ImageManifest> }>}
 */
export async function transformImageNodes(
  doc: JxMutableNode | JxDocument,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache?: ImageMetaCache,
) {
  const imageRefs: Map<string, ImageManifest> = new Map();

  if (!config.optimize) return { imageRefs };

  const meta = metaCache ?? new Map();
  await walkAndTransform(doc, config, projectRoot, cache, meta, imageRefs);

  return { imageRefs };
}

/**
 * @param {JxMutableNode | JxDocument} node
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {CacheManifest | null} cache
 * @param {ImageMetaCache} metaCache
 * @param {Map<string, ImageManifest>} imageRefs
 */
async function walkAndTransform(
  node: JxMutableNode | JxDocument,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache: ImageMetaCache,
  imageRefs: Map<string, ImageManifest>,
) {
  if (!node || typeof node !== "object") return;

  if (node.tagName === "img") {
    await transformImgNode(node, config, projectRoot, cache, metaCache, imageRefs);
  }

  if (typeof node.innerHTML === "string" && node.innerHTML.includes("<img")) {
    node.innerHTML = await transformInnerHtmlImages(
      node.innerHTML,
      config,
      projectRoot,
      cache,
      metaCache,
      imageRefs,
    );
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (typeof child === "string") continue;
      await walkAndTransform(child, config, projectRoot, cache, metaCache, imageRefs);
    }
  }
}

/**
 * @param {JxMutableNode | JxDocument} node
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {CacheManifest | null} cache
 * @param {ImageMetaCache} metaCache
 * @param {Map<string, ImageManifest>} imageRefs
 */
async function transformImgNode(
  node: JxMutableNode | JxDocument,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache: ImageMetaCache,
  imageRefs: Map<string, ImageManifest>,
) {
  if (!node.attributes) node.attributes = {};

  const src = node.attributes.src ?? node.src;
  if (shouldSkip(src)) return;
  if (node.attributes["data-no-optimize"] !== undefined) return;

  const absoluteSrc = resolveImagePath(src, projectRoot);
  if (!existsSync(absoluteSrc)) return;

  let srcset;
  let original: { width: number; height: number } | undefined;

  if (config.service === "cloudflare") {
    const meta = await resolveCfMeta(absoluteSrc, metaCache);
    srcset = buildCloudflareSrcset(src, config.widths, meta.width, meta.hash);
    original = meta;
  } else {
    let manifest = imageRefs.get(absoluteSrc);

    if (!manifest) {
      manifest = await resolveManifest(absoluteSrc, src, config, projectRoot, cache!);
      imageRefs.set(absoluteSrc, manifest);
    }

    const preferredFormat = config.formats.includes("avif") ? "avif" : config.formats[0];
    srcset = buildSrcset(manifest.variants, preferredFormat);
    original = manifest.original;
  }

  if (srcset) {
    node.attributes.srcset = srcset;
    node.attributes.sizes = node.attributes.sizes ?? config.sizes;
  }

  if (!node.attributes.width && original?.width) {
    node.attributes.width = String(original.width);
  }
  if (!node.attributes.height && original?.height) {
    node.attributes.height = String(original.height);
  }

  if (config.lazyLoad && node.attributes.loading !== "eager") {
    node.attributes.loading = "lazy";
    node.attributes.decoding = "async";
  }
}

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
const SRC_ATTR_RE = /\bsrc="([^"]*)"/;
const SRCSET_ATTR_RE = /\bsrcset="/;
const DATA_NO_OPT_RE = /\bdata-no-optimize\b/;

/**
 * Transform `<img>` tags embedded in pre-rendered innerHTML strings.
 *
 * @param {string} html
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {CacheManifest | null} cache
 * @param {ImageMetaCache} metaCache
 * @param {Map<string, ImageManifest>} imageRefs
 * @returns {Promise<string>}
 */
async function transformInnerHtmlImages(
  html: string,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache: ImageMetaCache,
  imageRefs: Map<string, ImageManifest>,
) {
  /** @type {{ match: string; replacement: string }[]} */
  const replacements = [];

  for (const m of html.matchAll(IMG_TAG_RE)) {
    const tag = m[0];
    const attrs = m[1];

    if (SRCSET_ATTR_RE.test(attrs)) continue;
    if (DATA_NO_OPT_RE.test(attrs)) continue;

    const srcMatch = attrs.match(SRC_ATTR_RE);
    if (!srcMatch) continue;

    const src = srcMatch[1];
    if (shouldSkip(src)) continue;

    const absoluteSrc = resolveImagePath(src, projectRoot);
    if (!existsSync(absoluteSrc)) continue;

    let srcset;
    let original: { width: number; height: number } | undefined;

    if (config.service === "cloudflare") {
      const meta = await resolveCfMeta(absoluteSrc, metaCache);
      srcset = buildCloudflareSrcset(src, config.widths, meta.width, meta.hash);
      original = meta;
    } else {
      let manifest = imageRefs.get(absoluteSrc);
      if (!manifest) {
        manifest = await resolveManifest(absoluteSrc, src, config, projectRoot, cache!);
        imageRefs.set(absoluteSrc, manifest);
      }

      const preferredFormat = config.formats.includes("avif") ? "avif" : config.formats[0];
      srcset = buildSrcset(manifest.variants, preferredFormat);
      original = manifest.original;
    }
    if (!srcset) continue;

    let extra = ` srcset="${srcset}" sizes="${config.sizes}"`;
    if (!/\bwidth=/.test(attrs) && original?.width) {
      extra += ` width="${original.width}"`;
    }
    if (!/\bheight=/.test(attrs) && original?.height) {
      extra += ` height="${original.height}"`;
    }
    if (config.lazyLoad && !/\bloading="eager"/.test(attrs)) {
      if (!/\bloading=/.test(attrs)) extra += ` loading="lazy"`;
      if (!/\bdecoding=/.test(attrs)) extra += ` decoding="async"`;
    }

    replacements.push({ match: tag, replacement: `<img${attrs}${extra}>` });
  }

  let result = html;
  for (const { match, replacement } of replacements) {
    result = result.replace(match, replacement);
  }
  return result;
}
