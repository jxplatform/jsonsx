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
export type ImageMetaCache = Map<
  string,
  { width: number | null; height: number | null; hash: string }
>;

let sharpWarned = false;

/**
 * Resolve original image dimensions and content hash for cloudflare mode. Reads only the image
 * header via Sharp — no variants are generated. Dimensions degrade to null when Sharp is
 * unavailable (e.g. native binary won't load): srcsets are still emitted (fit=scale-down guards
 * against upscaling), only the width/height attributes are skipped.
 *
 * @param {string} absoluteSrc
 * @param {ImageMetaCache} metaCache
 * @returns {Promise<{ width: number | null; height: number | null; hash: string }>}
 */
async function resolveCfMeta(absoluteSrc: string, metaCache: ImageMetaCache) {
  let meta = metaCache.get(absoluteSrc);
  if (!meta) {
    const hash = contentHash(absoluteSrc);
    try {
      const m = await getImageMetadata(absoluteSrc);
      meta = { width: m.width, height: m.height, hash };
    } catch (e) {
      if (!sharpWarned) {
        sharpWarned = true;
        console.warn(
          `Could not read image dimensions (${(e as Error).message}) — ` +
            `emitting srcsets without width/height attributes.`,
        );
      }
      meta = { width: null, height: null, hash };
    }
    metaCache.set(absoluteSrc, meta);
  }
  return meta;
}

/**
 * Build a srcset of Cloudflare `/cdn-cgi/image/` transform-via-URL entries for the configured
 * widths that fit within the original image width. `format=auto` lets Cloudflare negotiate
 * AVIF/WebP per browser; `fit=scale-down` guards against upscaling. Requires Image Transformations
 * to be enabled on the serving zone (does not work on *.pages.dev).
 *
 * @param {string} src - Site-relative src (e.g. "/images/hero.png") or allowlisted https URL
 * @param {ImageConfig} config
 * @param {number} originalWidth
 * @param {string | null} hash - 8-char content hash for cache busting (null for remote sources,
 *   whose bytes aren't available at build time)
 * @returns {string}
 */
function buildCloudflareSrcset(
  src: string,
  config: ImageConfig,
  originalWidth: number,
  hash: string | null,
) {
  const quality = config.quality?.webp ?? 80;
  const separator = src.startsWith("/") ? "" : "/";
  const suffix = hash ? `?v=${hash}` : "";
  return config.widths
    .filter((w) => w <= originalWidth)
    .sort((a, b) => a - b)
    .map(
      (w) =>
        `/cdn-cgi/image/width=${w},quality=${quality},fit=scale-down,format=auto` +
        `${separator}${src}${suffix} ${w}w`,
    )
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
 * Check if a remote src is eligible for cloudflare-service optimization: an https URL whose
 * hostname is in the project's `images.remoteDomains` allowlist. Content data (e.g. CSV columns)
 * routinely references externally hosted images — allowlisted hosts flow through the /cdn-cgi/image
 * transform URL like local assets; everything else passes through untouched. The zone must permit
 * resizing from the remote origin (Images → Transformations → Sources).
 *
 * @param {string} src
 * @param {ImageConfig} config
 * @returns {boolean}
 */
function isAllowedRemote(src: string, config: ImageConfig) {
  if (config.service !== "cloudflare") return false;
  if (!config.remoteDomains?.length) return false;
  if (typeof src !== "string" || !src.startsWith("https://")) return false;
  if (src.includes("${")) return false;
  try {
    const url = new URL(src);
    if (SKIP_EXTENSIONS.has(extname(url.pathname).toLowerCase())) return false;
    return config.remoteDomains.includes(url.hostname);
  } catch {
    return false;
  }
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
  const remote = isAllowedRemote(src, config);
  if (!remote && shouldSkip(src)) return;
  if (node.attributes["data-no-optimize"] !== undefined) return;

  const absoluteSrc = remote ? null : resolveImagePath(src, projectRoot);
  if (absoluteSrc && !existsSync(absoluteSrc)) return;

  let srcset;
  let original: { width: number; height: number } | undefined;

  if (remote) {
    // Original dimensions are unknown without fetching — emit every configured width and let
    // fit=scale-down avoid upscaling past the source size.
    srcset = buildCloudflareSrcset(src, config, Infinity, null);
  } else if (config.service === "cloudflare") {
    const meta = await resolveCfMeta(absoluteSrc as string, metaCache);
    srcset = buildCloudflareSrcset(src, config, meta.width ?? Infinity, meta.hash);
    if (meta.width != null && meta.height != null) {
      original = { width: meta.width, height: meta.height };
    }
  } else {
    let manifest = imageRefs.get(absoluteSrc as string);

    if (!manifest) {
      manifest = await resolveManifest(absoluteSrc as string, src, config, projectRoot, cache!);
      imageRefs.set(absoluteSrc as string, manifest);
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

    // Attribute values in pre-rendered innerHTML are entity-escaped — decode for processing
    const src = srcMatch[1].replaceAll("&amp;", "&");
    const remote = isAllowedRemote(src, config);
    if (!remote && shouldSkip(src)) continue;

    const absoluteSrc = remote ? null : resolveImagePath(src, projectRoot);
    if (absoluteSrc && !existsSync(absoluteSrc)) continue;

    let srcset;
    let original: { width: number; height: number } | undefined;

    if (remote) {
      srcset = buildCloudflareSrcset(src, config, Infinity, null);
    } else if (config.service === "cloudflare") {
      const meta = await resolveCfMeta(absoluteSrc as string, metaCache);
      srcset = buildCloudflareSrcset(src, config, meta.width ?? Infinity, meta.hash);
      if (meta.width != null && meta.height != null) {
        original = { width: meta.width, height: meta.height };
      }
    } else {
      let manifest = imageRefs.get(absoluteSrc as string);
      if (!manifest) {
        manifest = await resolveManifest(absoluteSrc as string, src, config, projectRoot, cache!);
        imageRefs.set(absoluteSrc as string, manifest);
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
