/**
 * Image-optimizer.js — Sharp wrapper for image resizing and format conversion.
 *
 * Generates responsive image variants (WebP, AVIF) at configured breakpoint widths. Returns an
 * ImageManifest describing all generated variants with their output paths.
 */

import { createHash } from "node:crypto";
import { errorMessage } from "@jxsuite/schema/parse";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { createRequire } from "node:module";
import type { FormatEnum } from "sharp";

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
  service?: "build" | "cloudflare";
  /**
   * Hostnames whose remote (https) images are routed through the optimization pipeline. Cloudflare
   * service only — allowlisted remote sources get /cdn-cgi/image transform srcsets (the zone must
   * permit resizing from the remote origin); everything else is left untouched.
   */
  remoteDomains?: string[];
}

// oxlint-disable-next-line typescript/consistent-type-imports -- sharp is an optional native dep loaded lazily; its `export =` module type is only nameable via import()
type SharpModule = typeof import("sharp");

let _sharp: SharpModule | null = null;

async function getSharp() {
  if (_sharp) {
    return _sharp;
  }
  // Primary: dynamic import — works in tests (mock.module intercepts it) and in
  // Production installs where @img/sharp-* native packages are adjacent to cli.js.
  try {
    const sharpMod = await import("sharp");
    _sharp = sharpMod.default as SharpModule;
    return _sharp;
  } catch {
    // Fall through to CJS fallback below.
  }
  // Fallback: resolve from the project being compiled. This covers symlinked
  // Monorepo dev environments (e.g. NixOS) where Node.js resolves import.meta.url
  // To the compiler package's real path, making the @img/sharp-* packages
  // Unreachable via the primary import path.
  try {
    const req = createRequire(resolve(process.cwd(), "package.json"));
    _sharp = req("sharp") as SharpModule;
    return _sharp;
  } catch (error) {
    throw new Error(
      `Sharp is required for image optimization but failed to load: ${errorMessage(error)}`,
      { cause: error },
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
    format: (meta.format ?? "unknown") as string,
    height: meta.height ?? 0,
    width: meta.width ?? 0,
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
    formats: config.formats,
    quality: config.quality,
    widths: config.widths,
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
 * Process a single source image: resize to each configured width, encode to each format. Writes
 * variants to cacheImgDir/_optimized/ (e.g. .cache/images/_optimized/).
 *
 * @param {string} srcPath - Absolute path to source image
 * @param {string} cacheImgDir - Absolute path to the image cache directory (.cache/images/)
 * @param {ImageConfig} config
 * @returns {Promise<ImageManifest>}
 */
export async function processImage(srcPath: string, cacheImgDir: string, config: ImageConfig) {
  const sharp = await getSharp();
  const meta = await getImageMetadata(srcPath);
  const hash8 = contentHash(srcPath);
  const stem = basename(srcPath, extname(srcPath));

  const optimizedDir = resolve(cacheImgDir, "_optimized");
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

      variants.push({ absolutePath, format, outputPath, width });

      if (existsSync(absolutePath)) {
        continue;
      }

      const quality = config.quality[format as keyof ImageConfig["quality"]] ?? 80;
      const task = sharp(srcPath)
        .resize(width)
        .toFormat(format as keyof FormatEnum, { quality })
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
    contentHash: hash8,
    original: { format: meta.format, height: meta.height, width: meta.width },
    variants,
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
