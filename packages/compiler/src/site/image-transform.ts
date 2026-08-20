/**
 * Image-transform.js — Document tree walker for responsive image optimization.
 *
 * Walks a Jx document tree, finds <img> nodes with static src paths, and injects srcset, sizes,
 * width, height, loading, and decoding attributes. Collects image references so the build
 * orchestrator knows which files to process.
 *
 * Two passes, deliberately separable. The **loading** pass (`images.lazyLoad`) runs on every image
 * in every project, because deciding not to optimize an image says nothing about when to fetch it.
 * The **variant** pass (`images.optimize`) is the expensive half and is the one the master switch
 * turns off.
 */

import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  buildSrcset,
  configHash,
  contentHash,
  getImageMetadata,
  processImage,
} from "./image-optimizer.ts";
import { getCached, getImageCacheDir, setCached } from "./image-cache.ts";
import { imgLoadingAttrs } from "./img-loading.ts";
import { resolveAssetUrl } from "@jxsuite/schema/asset-paths";

import type { AssetMount } from "@jxsuite/schema/asset-paths";
import type { ImageConfig, ImageManifest } from "./image-optimizer.ts";
import type { JxDocument, JxMutableNode } from "@jxsuite/schema/types";
import type { CacheManifest } from "./image-cache.ts";

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
    } catch (error) {
      if (!sharpWarned) {
        sharpWarned = true;
        console.warn(
          `Could not read image dimensions (${(error as Error).message}) — ` +
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
    .toSorted((a, b) => a - b)
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
    if (allExist) {
      return cached;
    }
  }

  if (!cached) {
    console.log(`    Optimizing ${basename(absoluteSrc)}...`);
  }
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
  if (typeof src !== "string") {
    return true;
  }
  if (!src) {
    return true;
  }
  if (src.includes("${")) {
    return true;
  }
  if (EXTERNAL_PREFIXES.some((p) => src.startsWith(p))) {
    return true;
  }
  if (SKIP_EXTENSIONS.has(extname(src).toLowerCase())) {
    return true;
  }
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
  if (config.service !== "cloudflare") {
    return false;
  }
  if (!config.remoteDomains?.length) {
    return false;
  }
  if (typeof src !== "string" || !src.startsWith("https://")) {
    return false;
  }
  if (src.includes("${")) {
    return false;
  }
  try {
    const url = new URL(src);
    if (SKIP_EXTENSIONS.has(extname(url.pathname).toLowerCase())) {
      return false;
    }
    return config.remoteDomains.includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve a src path to an absolute filesystem path.
 *
 * Extension asset mounts win first — they publish directories that may sit outside the project root
 * (extensions.md §8.5), so a mounted src has no other resolution. Otherwise paths starting with "/"
 * resolve into `public/`, and relative ones from the project root.
 *
 * @param {string} src
 * @param {string} projectRoot
 * @param {readonly AssetMount[]} [mounts]
 * @returns {string}
 */
function resolveImagePath(src: string, projectRoot: string, mounts?: readonly AssetMount[]) {
  const mounted = mounts?.length ? resolveAssetUrl(mounts, src) : null;
  if (mounted) {
    return mounted;
  }
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
 * @param {readonly AssetMount[]} [mounts] - Extension asset mounts (extensions.md §8.5)
 * @returns {Promise<{ imageRefs: Map<string, ImageManifest> }>}
 */
export async function transformImageNodes(
  doc: JxMutableNode | JxDocument,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache?: ImageMetaCache,
  mounts: readonly AssetMount[] = [],
) {
  const imageRefs = new Map<string, ImageManifest>();
  const meta = metaCache ?? new Map();
  await walkAndTransform(doc, config, projectRoot, cache, meta, imageRefs, mounts);
  return { imageRefs };
}

/**
 * @param {JxMutableNode | JxDocument} node
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {CacheManifest | null} cache
 * @param {ImageMetaCache} metaCache
 * @param {Map<string, ImageManifest>} imageRefs
 * @param {readonly AssetMount[]} mounts
 */
async function walkAndTransform(
  node: JxMutableNode | JxDocument,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache: ImageMetaCache,
  imageRefs: Map<string, ImageManifest>,
  mounts: readonly AssetMount[],
) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (node.tagName === "img") {
    await transformImgNode(node, config, projectRoot, cache, metaCache, imageRefs, mounts);
    // Wrapping rewrote this node into a `<picture>` whose children this pass just authored.
    // Descending into them would find the `<img>` and wrap it again, forever.
    if (node.tagName !== "img") {
      return;
    }
  }

  if (typeof node.innerHTML === "string" && node.innerHTML.includes("<img")) {
    node.innerHTML = await transformInnerHtmlImages(
      node.innerHTML,
      config,
      projectRoot,
      cache,
      metaCache,
      imageRefs,
      mounts,
    );
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (typeof child === "string") {
        continue;
      }
      await walkAndTransform(child, config, projectRoot, cache, metaCache, imageRefs, mounts);
    }
  }
}

/** A `<source>` in a generated `<picture>`: one image format, one candidate list. */
interface PictureSource {
  type: string;
  srcset: string;
}

/**
 * Formats in the order a browser should be offered them — best compression first. A `<picture>`
 * takes the FIRST source it can decode, so this order is the whole negotiation.
 */
const PICTURE_FORMAT_ORDER: readonly string[] = ["avif", "webp", "jpeg", "png"];
const MEDIA_TYPES: Record<string, string> = {
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

interface ResolvedVariants {
  /** Candidate list for the `<img>` itself, in the preferred format. */
  srcset: string;
  dims: { width: number; height: number } | null;
  /** One entry per additional format, when the image is to be wrapped in a `<picture>`. */
  sources: PictureSource[];
}

/**
 * Generate (or look up) this image's variants and describe what the markup should say.
 *
 * Returns null whenever the image is not ours to touch — a bound `src`, an SVG, a remote URL off
 * the allowlist, a missing file, an explicit `data-no-optimize`. Both callers treat null the same
 * way: leave the markup alone apart from the loading attributes.
 *
 * @param {string} src
 * @param {boolean} optedOut - `data-no-optimize` is present
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {CacheManifest | null} cache
 * @param {ImageMetaCache} metaCache
 * @param {Map<string, ImageManifest>} imageRefs
 * @param {readonly AssetMount[]} mounts
 * @returns {Promise<ResolvedVariants | null>}
 */
async function resolveVariants(
  src: string,
  optedOut: boolean,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache: ImageMetaCache,
  imageRefs: Map<string, ImageManifest>,
  mounts: readonly AssetMount[],
): Promise<ResolvedVariants | null> {
  // Bound ($ref) or missing srcs cannot be optimized at build time.
  if (typeof src !== "string" || optedOut) {
    return null;
  }
  const remote = isAllowedRemote(src, config);
  if (!remote && shouldSkip(src)) {
    return null;
  }

  if (remote) {
    // Original dimensions are unknown without fetching — emit every configured width and let
    // Fit=scale-down avoid upscaling past the source size.
    return { dims: null, sources: [], srcset: buildCloudflareSrcset(src, config, Infinity, null) };
  }

  const absoluteSrc = resolveImagePath(src, projectRoot, mounts);
  if (!existsSync(absoluteSrc)) {
    return null;
  }

  if (config.service === "cloudflare") {
    // Cloudflare negotiates the format itself (`format=auto`), so there is nothing for a
    // `<picture>` to choose between.
    const meta = await resolveCfMeta(absoluteSrc, metaCache);
    const srcset = buildCloudflareSrcset(src, config, meta.width ?? Infinity, meta.hash);
    const dims = meta.width && meta.height ? { height: meta.height, width: meta.width } : null;
    return { dims, sources: [], srcset };
  }

  let manifest = imageRefs.get(absoluteSrc);
  if (!manifest) {
    manifest = await resolveManifest(absoluteSrc, src, config, projectRoot, cache!);
    imageRefs.set(absoluteSrc, manifest);
  }

  /*
   * The project's own formats, best-compression first. A format the project did not ask for is not
   * offered even if a stale manifest happens to hold variants of it, and one this order does not
   * know keeps the position the project gave it.
   */
  const ordered = [
    ...PICTURE_FORMAT_ORDER.filter((format) => config.formats.includes(format)),
    ...config.formats.filter((format) => !PICTURE_FORMAT_ORDER.includes(format)),
  ];
  const available = ordered
    .map((format) => ({
      srcset: buildSrcset(manifest.variants, format),
      type: MEDIA_TYPES[format] ?? `image/${format}`,
    }))
    .filter((source) => source.srcset !== "");

  const dims =
    manifest.original?.width && manifest.original.height
      ? { height: manifest.original.height, width: manifest.original.width }
      : null;
  /*
   * One format needs no negotiation, and a srcset in the single format the project asked for is
   * both smaller markup and the historical behaviour. Two or more do: `srcset` alone carries no
   * format information, so a browser that cannot decode AVIF would still pick an AVIF candidate.
   */
  const wrap = config.picture !== false && available.length > 1;
  return { dims, sources: wrap ? available : [], srcset: available[0]?.srcset ?? "" };
}

/**
 * @param {JxMutableNode | JxDocument} node
 * @param {ImageConfig} config
 * @param {string} projectRoot
 * @param {CacheManifest | null} cache
 * @param {ImageMetaCache} metaCache
 * @param {Map<string, ImageManifest>} imageRefs
 * @param {readonly AssetMount[]} mounts
 */
async function transformImgNode(
  node: JxMutableNode | JxDocument,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache: ImageMetaCache,
  imageRefs: Map<string, ImageManifest>,
  mounts: readonly AssetMount[],
) {
  if (!node.attributes) {
    node.attributes = {};
  }
  const attrs = node.attributes;
  /*
   * A node-level `src` is normalized into `attributes` first. The static emitter only renders a
   * fixed set of node-level DOM properties and `src` is not among them, so an image written that
   * way used to acquire a `srcset` and lose its `src` — the fallback the srcset exists to have.
   */
  if (attrs.src === undefined && typeof node.src === "string") {
    attrs.src = node.src;
    delete node.src;
  }

  const variants = config.optimize
    ? await resolveVariants(
        attrs.src as string,
        attrs["data-no-optimize"] !== undefined,
        config,
        projectRoot,
        cache,
        metaCache,
        imageRefs,
        mounts,
      )
    : null;

  if (variants) {
    if (variants.srcset !== "") {
      attrs.srcset = variants.srcset;
      attrs.sizes ??= config.sizes;
    }
    // Intrinsic dimensions prevent layout shift; author-supplied values win.
    if (variants.dims && attrs.width === undefined && attrs.height === undefined) {
      attrs.width = String(variants.dims.width);
      attrs.height = String(variants.dims.height);
    }
  }

  Object.assign(attrs, imgLoadingAttrs(attrs, config.lazyLoad));

  if (variants && variants.sources.length > 0) {
    wrapInPicture(node, variants.sources, config.sizes);
  }
}

/**
 * Turn an `<img>` node into a `<picture>` wrapping it, one `<source>` per format.
 *
 * The `<img>` keeps everything that describes the image — `src`, `alt`, dimensions, styles, the
 * loading attributes — and loses `srcset`/`sizes`, which now live on the sources. That is what
 * makes it a real fallback: a browser that matches no `<source>` gets the original file, not a
 * candidate list in a format it just declined.
 *
 * @param {JxMutableNode | JxDocument} node - The `<img>` node, mutated into a `<picture>`
 * @param {PictureSource[]} sources
 * @param {string} sizes
 */
function wrapInPicture(
  node: JxMutableNode | JxDocument,
  sources: readonly PictureSource[],
  sizes: string,
) {
  const imgAttrs: Record<string, unknown> = { ...node.attributes };
  const inheritedSizes = (imgAttrs.sizes as string | undefined) ?? sizes;
  delete imgAttrs.srcset;
  delete imgAttrs.sizes;
  const img: Record<string, unknown> = { attributes: imgAttrs, tagName: "img" };
  if (node.style !== undefined) {
    img.style = node.style;
    delete node.style;
  }

  node.tagName = "picture";
  node.attributes = {};
  node.children = [
    ...sources.map((source) => ({
      attributes: { sizes: inheritedSizes, srcset: source.srcset, type: source.type },
      tagName: "source",
    })),
    img,
  ] as (string | JxMutableNode)[];
}

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
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
 * @param {readonly AssetMount[]} mounts
 * @returns {Promise<string>}
 */
async function transformInnerHtmlImages(
  html: string,
  config: ImageConfig,
  projectRoot: string,
  cache: CacheManifest | null,
  metaCache: ImageMetaCache,
  imageRefs: Map<string, ImageManifest>,
  mounts: readonly AssetMount[],
) {
  const replacements: { match: string; replacement: string }[] = [];

  for (const m of html.matchAll(IMG_TAG_RE)) {
    const tag = m[0]!;
    const attrs = m[1]!;

    // Attribute values in pre-rendered innerHTML are entity-escaped — decode for processing
    const src = (attrValue(attrs, "src") ?? "").replaceAll("&amp;", "&");
    const alreadyResponsive = SRCSET_ATTR_RE.test(attrs);
    const variants =
      config.optimize && src !== "" && !alreadyResponsive
        ? await resolveVariants(
            src,
            DATA_NO_OPT_RE.test(attrs),
            config,
            projectRoot,
            cache,
            metaCache,
            imageRefs,
            mounts,
          )
        : null;

    let extra = "";
    if (variants && variants.srcset !== "") {
      extra += ` srcset="${variants.srcset}" sizes="${config.sizes}"`;
    }
    if (variants?.dims && !/\bwidth=/.test(attrs) && !/\bheight=/.test(attrs)) {
      extra += ` width="${variants.dims.width}" height="${variants.dims.height}"`;
    }
    const loading = imgLoadingAttrs(
      {
        decoding: attrValue(attrs, "decoding"),
        fetchpriority: attrValue(attrs, "fetchpriority"),
        loading: attrValue(attrs, "loading"),
      },
      config.lazyLoad,
    );
    for (const [key, value] of Object.entries(loading)) {
      extra += ` ${key}="${value}"`;
    }

    if (extra === "") {
      continue;
    }

    const img =
      variants && variants.sources.length > 0
        ? renderPictureTag(attrs, variants.sources, config.sizes, extra)
        : `<img${attrs}${extra}>`;
    replacements.push({ match: tag, replacement: img });
  }

  let result = html;
  for (const { match, replacement } of replacements) {
    result = result.replace(match, replacement);
  }
  return result;
}

/**
 * The string-surgery twin of {@link wrapInPicture}: the same markup, built from a raw attribute
 * string rather than a node. `srcset`/`sizes` stay off the `<img>` so it remains a real fallback.
 *
 * @param {string} attrs - The original tag's attribute string
 * @param {readonly PictureSource[]} sources
 * @param {string} sizes
 * @param {string} extra - Attributes this pass decided to add
 * @returns {string}
 */
function renderPictureTag(
  attrs: string,
  sources: readonly PictureSource[],
  sizes: string,
  extra: string,
) {
  const inheritedSizes = attrValue(attrs, "sizes") ?? sizes;
  const imgExtra = extra.replace(/ srcset="[^"]*"/, "").replace(/ sizes="[^"]*"/, "");
  const sourceTags = sources
    .map((s) => `<source type="${s.type}" srcset="${s.srcset}" sizes="${inheritedSizes}">`)
    .join("");
  return `<picture>${sourceTags}<img${attrs}${imgExtra}></picture>`;
}

/**
 * Read one double-quoted attribute out of a raw tag attribute string.
 *
 * @param {string} attrs
 * @param {string} name
 * @returns {string | undefined}
 */
function attrValue(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs)?.[1];
}
