/**
 * Image-optimizer.js — Sharp wrapper for image resizing and format conversion.
 *
 * Generates responsive image variants (WebP, AVIF) at configured breakpoint widths. Returns an
 * ImageManifest describing all generated variants with their output paths.
 */

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { createRequire } from "node:module";

export interface ImageVariant {
  width: number; // Pixel width of the variant
  format: string; // "webp", "avif", "jpeg", "png"
  outputPath: string; // Relative path from outDir (e.g.
  absolutePath: string; // Absolute filesystem path to the generated file
}

export interface ImageManifest {
  variants: ImageVariant[]; // Array of generated responsive variants
  contentHash: string; // 8-char content hash for cache busting
  original?: { width: number; height: number }; // Original image dimensions
}

export interface ImageConfig {
  optimize: boolean;
  widths: number[];
  formats: string[];
  quality: { webp?: number; avif?: number; jpeg?: number; png?: number };
  sizes: string;
  lazyLoad: boolean;
}

let _sharp: typeof import("sharp") | null = null;

async function getSharp() {
  if (_sharp) return _sharp;
  // Primary: dynamic import — works in tests (mock.module intercepts it) and in
  // production installs where @img/sharp-* native packages are adjacent to cli.js.
  try {
    const sharpMod = await import("sharp");
    _sharp = sharpMod.default as typeof import("sharp");
    return _sharp;
  } catch {
    // Fall through to CJS fallback below.
  }
  // Fallback: resolve from the project being compiled. This covers symlinked
  // monorepo dev environments (e.g. NixOS) where Node.js resolves import.meta.url
  // to the compiler package's real path, making the @img/sharp-* packages
  // unreachable via the primary import path.
  try {
    const req = createRequire(resolve(process.cwd(), "package.json"));
    _sharp = req("sharp") as typeof import("sharp");
    return _sharp;
  } catch (e) {
    throw new Error(
      `Sharp is required for image optimization but failed to load: ${(e as Error).message}`,
    );
  }
}

const OPTIMIZED_DIR = "images/_optimized";

/**
 * Get image metadata (dimensions and format) via Sharp.
 *
 * @param {string} srcPath - Absolute path to source image
 * @returns {Promise<{ width: number; height: number; format: string }>}
 */
export async function getImageMetadata(srcPath: string) {
  const sharp = await getSharp();
  const meta = await sharp(srcPath).metadata();
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    format: (meta.format ?? "unknown") as string,
  };
}

/**
 * Compute a content hash for a source image file.
 *
 * @param {string} srcPath - Absolute path to source image
 * @returns {string} 8-character hex hash
 */
export function contentHash(srcPath: string) {
  const buf = readFileSync(srcPath);
  return createHash("md5").update(buf).digest("hex").slice(0, 8);
}

/**
 * Compute a config hash from the image optimization settings.
 *
 * @param {ImageConfig} config
 * @returns {string}
 */
export function configHash(config: ImageConfig) {
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
export function variantFilename(stem: string, width: number, hash8: string, format: string) {
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
export async function processImage(srcPath: string, outDir: string, config: ImageConfig) {
  const sharp = await getSharp();
  const meta = await getImageMetadata(srcPath);
  const hash8 = contentHash(srcPath);
  const stem = basename(srcPath, extname(srcPath));

  const optimizedDir = resolve(outDir, OPTIMIZED_DIR);
  mkdirSync(optimizedDir, { recursive: true });

  const variants: ImageVariant[] = [];

  const widths = config.widths.filter((w) => w <= meta.width);
  if (widths.length === 0 || !widths.includes(meta.width)) {
    widths.push(meta.width);
  }
  widths.sort((a, b) => a - b);

  const tasks: Promise<void>[] = [];

  for (const width of widths) {
    for (const format of config.formats) {
      const filename = variantFilename(stem, width, hash8, format);
      const outputPath = `/${OPTIMIZED_DIR}/${filename}`;
      const absolutePath = resolve(optimizedDir, filename);

      variants.push({ width, format, outputPath, absolutePath });

      if (existsSync(absolutePath)) continue;

      const quality = config.quality[format as keyof ImageConfig["quality"]] ?? 80;
      const task = sharp(srcPath)
        .resize(width)
        .toFormat(format as keyof import("sharp").FormatEnum, { quality })
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
export function buildSrcset(variants: ImageVariant[], format: string) {
  return variants
    .filter((v) => v.format === format)
    .map((v) => `${v.outputPath} ${v.width}w`)
    .join(", ");
}
