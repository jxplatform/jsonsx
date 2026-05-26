/**
 * Image-transform.js — Document tree walker for responsive image optimization.
 *
 * Walks a Jx document tree, finds <img> nodes with static src paths, and injects srcset, sizes,
 * width, height, loading, and decoding attributes. Collects image references so the build
 * orchestrator knows which files to process.
 */

import { existsSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import { processImage, buildSrcset, contentHash, configHash } from "./image-optimizer.js";
import { getCached, setCached } from "./image-cache.js";

/**
 * @typedef {import("./image-optimizer.js").ImageConfig} ImageConfig
 *
 * @typedef {import("./image-optimizer.js").ImageManifest} ImageManifest
 *
 * @typedef {import("./image-cache.js").CacheManifest} CacheManifest
 */

const SKIP_EXTENSIONS = new Set([".svg", ".gif"]);
const EXTERNAL_PREFIXES = ["http://", "https://", "data:", "//"];

/**
 * @param {string} absoluteSrc
 * @param {string} src
 * @param {ImageConfig} config
 * @param {string} outDir
 * @param {CacheManifest} cache
 * @returns {Promise<ImageManifest>}
 */
async function resolveManifest(absoluteSrc, src, config, outDir, cache) {
  const key = `${contentHash(absoluteSrc)}:${configHash(config)}`;
  const cached = getCached(cache, key);

  if (cached) {
    const allExist = cached.variants.every((v) => existsSync(v.absolutePath));
    if (allExist) return cached;
  }

  if (!cached) console.log(`    Optimizing ${basename(absoluteSrc)}...`);
  const manifest = await processImage(absoluteSrc, outDir, config);
  setCached(cache, key, src, manifest);
  return manifest;
}

/**
 * Check if a src value should be skipped for optimization.
 *
 * @param {string} src
 * @returns {boolean}
 */
function shouldSkip(src) {
  if (typeof src !== "string") return true;
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
function resolveImagePath(src, projectRoot) {
  if (src.startsWith("/")) {
    return resolve(projectRoot, "public", src.slice(1));
  }
  return resolve(projectRoot, src);
}

/**
 * Transform image nodes in a Jx document tree.
 *
 * Mutates img nodes in place, injecting srcset, sizes, width, height, loading, and decoding.
 * Returns a set of absolute source paths that need processing.
 *
 * @param {JxMutableNode | JxDocument} doc - The Jx document tree (mutated in place)
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {string} outDir
 * @param {CacheManifest} cache
 * @returns {Promise<{ imageRefs: Map<string, ImageManifest> }>}
 */
export async function transformImageNodes(doc, config, projectRoot, outDir, cache) {
  /** @type {Map<string, ImageManifest>} */
  const imageRefs = new Map();

  if (!config.optimize) return { imageRefs };

  await walkAndTransform(doc, config, projectRoot, outDir, cache, imageRefs);

  return { imageRefs };
}

/**
 * @param {JxMutableNode | JxDocument} node
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {string} outDir
 * @param {CacheManifest} cache
 * @param {Map<string, ImageManifest>} imageRefs
 */
async function walkAndTransform(node, config, projectRoot, outDir, cache, imageRefs) {
  if (!node || typeof node !== "object") return;

  if (node.tagName === "img") {
    await transformImgNode(node, config, projectRoot, outDir, cache, imageRefs);
  }

  if (typeof node.innerHTML === "string" && node.innerHTML.includes("<img")) {
    node.innerHTML = await transformInnerHtmlImages(
      node.innerHTML,
      config,
      projectRoot,
      outDir,
      cache,
      imageRefs,
    );
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (typeof child === "string") continue;
      await walkAndTransform(child, config, projectRoot, outDir, cache, imageRefs);
    }
  }
}

/**
 * @param {JxMutableNode | JxDocument} node
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {string} outDir
 * @param {CacheManifest} cache
 * @param {Map<string, ImageManifest>} imageRefs
 */
async function transformImgNode(node, config, projectRoot, outDir, cache, imageRefs) {
  if (!node.attributes) node.attributes = {};

  const src = node.attributes.src ?? node.src;
  if (shouldSkip(src)) return;
  if (node.attributes["data-no-optimize"] !== undefined) return;

  const absoluteSrc = resolveImagePath(src, projectRoot);
  if (!existsSync(absoluteSrc)) return;

  let manifest = imageRefs.get(absoluteSrc);

  if (!manifest) {
    manifest = await resolveManifest(absoluteSrc, src, config, outDir, cache);
    imageRefs.set(absoluteSrc, manifest);
  }

  const preferredFormat = config.formats.includes("avif") ? "avif" : config.formats[0];
  const srcset = buildSrcset(manifest.variants, preferredFormat);

  if (srcset) {
    node.attributes.srcset = srcset;
    node.attributes.sizes = node.attributes.sizes ?? config.sizes;
  }

  if (!node.attributes.width && manifest.original.width) {
    node.attributes.width = String(manifest.original.width);
  }
  if (!node.attributes.height && manifest.original.height) {
    node.attributes.height = String(manifest.original.height);
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
 * @param {string} outDir
 * @param {CacheManifest} cache
 * @param {Map<string, ImageManifest>} imageRefs
 * @returns {Promise<string>}
 */
async function transformInnerHtmlImages(html, config, projectRoot, outDir, cache, imageRefs) {
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

    let manifest = imageRefs.get(absoluteSrc);
    if (!manifest) {
      manifest = await resolveManifest(absoluteSrc, src, config, outDir, cache);
      imageRefs.set(absoluteSrc, manifest);
    }

    const preferredFormat = config.formats.includes("avif") ? "avif" : config.formats[0];
    const srcset = buildSrcset(manifest.variants, preferredFormat);
    if (!srcset) continue;

    let extra = ` srcset="${srcset}" sizes="${config.sizes}"`;
    if (!/\bwidth=/.test(attrs) && manifest.original.width) {
      extra += ` width="${manifest.original.width}"`;
    }
    if (!/\bheight=/.test(attrs) && manifest.original.height) {
      extra += ` height="${manifest.original.height}"`;
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
