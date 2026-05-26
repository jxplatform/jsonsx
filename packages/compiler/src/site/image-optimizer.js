/**
 * Image-optimizer.js — Sharp wrapper for image resizing and format conversion.
 *
 * Generates responsive image variants (WebP, AVIF) at configured breakpoint widths. Returns an
 * ImageManifest describing all generated variants with their output paths.
 */

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";

/** @type {typeof import("sharp") | null} */
let _sharp = null;

async function getSharp() {
  if (_sharp) return _sharp;
  try {
    const sharpMod = await import("sharp");
    _sharp = sharpMod.default;
    return _sharp;
  } catch (e) {
    throw new Error(
      `Sharp is required for image optimization but failed to load: ${/** @type {Error} */ (e).message}`,
    );
  }
}

/**
 * @typedef {Object} ImageVariant
 * @property {number} width - Pixel width of the variant
 * @property {string} format - "webp", "avif", "jpeg", "png"
 * @property {string} outputPath - Relative path from outDir (e.g.
 *   "/images/_optimized/hero-640-a1b2c3d4.webp")
 * @property {string} absolutePath - Absolute filesystem path to the generated file
 */

/**
 * @typedef {Object} ImageManifest
 * @property {{ width: number; height: number; format: string }} original - Original image
 *   dimensions and format
 * @property {ImageVariant[]} variants - Array of generated responsive variants
 * @property {string} contentHash - 8-char content hash for cache busting
 */

/**
 * @typedef {Object} ImageConfig
 * @property {boolean} optimize - Enable image optimization
 * @property {number[]} widths - Breakpoint widths to generate
 * @property {string[]} formats - Output formats ("webp", "avif", etc.)
 * @property {{ webp?: number; avif?: number; jpeg?: number; png?: number }} quality - Compression
 *   quality per format
 * @property {string} sizes - CSS sizes attribute for srcset
 * @property {boolean} lazyLoad - Add loading="lazy" and decoding="async"
 */

const OPTIMIZED_DIR = "images/_optimized";

/**
 * Get image metadata (dimensions and format) via Sharp.
 *
 * @param {string} srcPath - Absolute path to source image
 * @returns {Promise<{ width: number; height: number; format: string }>}
 */
export async function getImageMetadata(srcPath) {
  const sharp = await getSharp();
  const meta = await sharp(srcPath).metadata();
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    format: meta.format ?? "unknown",
  };
}

/**
 * Compute a content hash for a source image file.
 *
 * @param {string} srcPath - Absolute path to source image
 * @returns {string} 8-character hex hash
 */
export function contentHash(srcPath) {
  const buf = readFileSync(srcPath);
  return createHash("md5").update(buf).digest("hex").slice(0, 8);
}

/**
 * Compute a config hash from the image optimization settings.
 *
 * @param {ImageConfig} config
 * @returns {string}
 */
export function configHash(config) {
  const key = JSON.stringify({
    widths: config.widths,
    formats: config.formats,
    quality: config.quality,
  });
  return createHash("md5").update(key).digest("hex").slice(0, 8);
}

/**
 * Build the output filename for a variant.
 *
 * @param {string} stem - Original filename without extension
 * @param {number} width
 * @param {string} hash8 - 8-char content hash
 * @param {string} format - "webp", "avif", "jpeg", "png"
 * @returns {string}
 */
export function variantFilename(stem, width, hash8, format) {
  return `${stem}-${width}-${hash8}.${format}`;
}

/**
 * Process a single source image: resize to each configured width, encode to each format.
 *
 * @param {string} srcPath - Absolute path to source image
 * @param {string} outDir - Absolute path to the build output directory (dist/)
 * @param {ImageConfig} config
 * @returns {Promise<ImageManifest>}
 */
export async function processImage(srcPath, outDir, config) {
  const sharp = await getSharp();
  const meta = await getImageMetadata(srcPath);
  const hash8 = contentHash(srcPath);
  const stem = basename(srcPath, extname(srcPath));

  const optimizedDir = resolve(outDir, OPTIMIZED_DIR);
  mkdirSync(optimizedDir, { recursive: true });

  /** @type {ImageVariant[]} */
  const variants = [];

  const widths = config.widths.filter((w) => w <= meta.width);
  if (widths.length === 0 || !widths.includes(meta.width)) {
    widths.push(meta.width);
  }
  widths.sort((a, b) => a - b);

  /** @type {Promise<void>[]} */
  const tasks = [];

  for (const width of widths) {
    for (const format of config.formats) {
      const filename = variantFilename(stem, width, hash8, format);
      const outputPath = `/${OPTIMIZED_DIR}/${filename}`;
      const absolutePath = resolve(optimizedDir, filename);

      variants.push({ width, format, outputPath, absolutePath });

      if (existsSync(absolutePath)) continue;

      const quality = config.quality[/** @type {keyof ImageConfig["quality"]} */ (format)] ?? 80;
      const task = sharp(srcPath)
        .resize(width)
        .toFormat(/** @type {keyof import("sharp").FormatEnum} */ (format), { quality })
        .toFile(absolutePath)
        .then(() => {});

      tasks.push(task);
    }
  }

  const CONCURRENCY = 4;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + CONCURRENCY));
  }

  return {
    original: { width: meta.width, height: meta.height, format: meta.format },
    variants,
    contentHash: hash8,
  };
}

/**
 * Build a srcset string from variants of a specific format.
 *
 * @param {ImageVariant[]} variants
 * @param {string} format
 * @returns {string}
 */
export function buildSrcset(variants, format) {
  return variants
    .filter((v) => v.format === format)
    .map((v) => `${v.outputPath} ${v.width}w`)
    .join(", ");
}
