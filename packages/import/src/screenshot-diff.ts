/**
 * Screenshot-diff — pixel-level PNG comparison for fidelity scoring.
 *
 * Compares two same-size PNG screenshots and returns a fidelity percentage (100% = identical, 0% =
 * completely different) plus an optional diff image.
 */

import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export interface DiffResult {
  /** 0..100 — percentage of pixels that match (within threshold). */
  fidelity: number;
  /** Total pixel count in the comparison area. */
  totalPixels: number;
  /** Number of pixels that differ beyond the threshold. */
  mismatchedPixels: number;
  /** Width of the compared images. */
  width: number;
  /** Height of the compared images. */
  height: number;
  /** PNG buffer of the diff visualization (mismatches highlighted in red). */
  diffPng: Buffer;
}

export interface DiffOptions {
  /** Pixelmatch color threshold (0..1, default 0.15 — tolerant of antialiasing/compression). */
  threshold?: number;
}

/**
 * Compare two PNG buffers pixel-by-pixel.
 *
 * If images differ in size, the smaller is padded (treated as white) to match the larger — size
 * mismatch alone doesn't throw.
 */
export function diffScreenshots(
  pngA: Buffer | Uint8Array,
  pngB: Buffer | Uint8Array,
  opts: DiffOptions = {},
): DiffResult {
  const { threshold = 0.15 } = opts;

  const imgA = PNG.sync.read(Buffer.from(pngA));
  const imgB = PNG.sync.read(Buffer.from(pngB));

  const width = Math.max(imgA.width, imgB.width);
  const height = Math.max(imgA.height, imgB.height);

  const dataA = padToSize(imgA, width, height);
  const dataB = padToSize(imgB, width, height);

  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(dataA, dataB, diff.data, width, height, {
    threshold,
    includeAA: true,
  });

  const totalPixels = width * height;
  const fidelity = totalPixels > 0 ? ((totalPixels - mismatchedPixels) / totalPixels) * 100 : 100;

  return {
    fidelity: Math.round(fidelity * 100) / 100,
    totalPixels,
    mismatchedPixels,
    width,
    height,
    diffPng: PNG.sync.write(diff),
  };
}

/**
 * Pad a PNG's pixel data to a target size with white pixels. Returns the raw RGBA Uint8Array at the
 * target dimensions.
 */
function padToSize(img: PNG, targetWidth: number, targetHeight: number): Uint8Array {
  if (img.width === targetWidth && img.height === targetHeight) {
    return img.data;
  }

  const out = new Uint8Array(targetWidth * targetHeight * 4);
  // Fill with white (255,255,255,255)
  out.fill(255);

  for (let y = 0; y < img.height; y++) {
    const srcOffset = y * img.width * 4;
    const dstOffset = y * targetWidth * 4;
    out.set(img.data.subarray(srcOffset, srcOffset + img.width * 4), dstOffset);
  }

  return out;
}
