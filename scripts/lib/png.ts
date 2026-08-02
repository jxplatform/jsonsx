/**
 * A dependency-free PNG reader, for the screenshot lane's "what actually changed" report.
 *
 * `scripts/check-image-lock.ts --report` has to say **12.4% of pixels** rather than **the bytes
 * differ**, because a reviewer asked to eyeball 65 images will eyeball none. Saying it needs a
 * decoder, and this repo deliberately has none: `scripts/screenshots/thumbnails.ts` already builds
 * with image optimisation off because "Sharp is unavailable on some hosts" (NixOS), and CLAUDE.md
 * requires sharp to be mocked in every test for the same reason. So a native image dependency
 * cannot be added here without making the check unrunnable on a maintainer's laptop.
 *
 * What is supported is exactly what headless Chromium emits: bit depth 8, colour types 0/2/4/6, no
 * interlace. Anything else decodes to `null` and the report degrades to a byte-level line — a
 * missing percentage is a worse report, not a failed job.
 */

import { inflateSync } from "node:zlib";

/** `\x89PNG\r\n\x1a\n` — the 8-byte signature every PNG opens with. */
const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Channels per pixel, by IHDR colour type. Indices 1, 3 and 5 are palette/undefined. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export interface PngSize {
  width: number;
  height: number;
}

/** A decoded image, always widened to 8-bit RGBA so comparison never branches on colour type. */
export interface PngImage extends PngSize {
  /** `width * height * 4` bytes, row-major, R G B A. */
  pixels: Uint8Array;
}

function hasSignature(bytes: Uint8Array): boolean {
  return SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * A big-endian uint32, in arithmetic rather than shifts.
 *
 * `.oxlintrc.json` bans bitwise operators repo-wide and this file is not the place to argue for an
 * exception: `* 256` reads the same and cannot silently coerce to int32 the way `<< 24` does.
 */
function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 16_777_216 +
    bytes[offset + 1]! * 65_536 +
    bytes[offset + 2]! * 256 +
    bytes[offset + 3]!
  );
}

/** Four ASCII bytes as a chunk type (`IHDR`, `IDAT`, `IEND`). */
function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCodePoint(...bytes.slice(offset, offset + 4));
}

/**
 * Width and height from IHDR, without inflating a single byte.
 *
 * The lock records `w`/`h` for every image, and a 2.4 MB capture costs ~24 bytes to measure this
 * way; `writeLock` therefore never pays for a decode it does not need.
 */
export function readPngSize(bytes: Uint8Array): PngSize | null {
  if (bytes.length < 24 || !hasSignature(bytes)) {
    return null;
  }
  // Byte 8 begins the first chunk; IHDR is required by the spec to be first.
  if (chunkType(bytes, 12) !== "IHDR") {
    return null;
  }
  return { width: readU32(bytes, 16), height: readU32(bytes, 20) };
}

interface Header extends PngSize {
  bitDepth: number;
  colorType: number;
  interlace: number;
}

interface Chunks {
  header: Header;
  data: Uint8Array;
}

/** Walk the chunk list, concatenating IDAT. Returns null on anything malformed. */
function readChunks(bytes: Uint8Array): Chunks | null {
  if (!hasSignature(bytes)) {
    return null;
  }
  let header: Header | undefined;
  const parts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = chunkType(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) {
      return null;
    }
    if (type === "IHDR") {
      header = {
        width: readU32(bytes, start),
        height: readU32(bytes, start + 4),
        bitDepth: bytes[start + 8]!,
        colorType: bytes[start + 9]!,
        interlace: bytes[start + 12]!,
      };
    } else if (type === "IDAT") {
      parts.push(bytes.slice(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (!header) {
    return null;
  }
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const data = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    data.set(part, cursor);
    cursor += part.length;
  }
  return { data, header };
}

/** Paeth predictor, verbatim from the PNG spec's filter type 4. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Reverse the per-row filter in place, returning the raw scanlines without their filter bytes. */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const inRow = y * (stride + 1) + 1;
    const outRow = y * stride;
    const prevRow = outRow - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[inRow + x]!;
      const left = x >= channels ? out[outRow + x - channels]! : 0;
      const up = y > 0 ? out[prevRow + x]! : 0;
      const upLeft = y > 0 && x >= channels ? out[prevRow + x - channels]! : 0;
      let restored: number;
      switch (filter) {
        case 1: {
          restored = value + left;
          break;
        }
        case 2: {
          restored = value + up;
          break;
        }
        case 3: {
          restored = value + Math.floor((left + up) / 2);
          break;
        }
        case 4: {
          restored = value + paeth(left, up, upLeft);
          break;
        }
        default: {
          restored = value;
        }
      }
      out[outRow + x] = restored % 256;
    }
  }
  return out;
}

/** Widen gray / gray+alpha / RGB scanlines to RGBA. */
function toRgba(scanlines: Uint8Array, pixels: number, channels: number): Uint8Array {
  if (channels === 4) {
    return scanlines;
  }
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const from = i * channels;
    const to = i * 4;
    if (channels === 1 || channels === 2) {
      const gray = scanlines[from]!;
      out[to] = gray;
      out[to + 1] = gray;
      out[to + 2] = gray;
      out[to + 3] = channels === 2 ? scanlines[from + 1]! : 255;
      continue;
    }
    out[to] = scanlines[from]!;
    out[to + 1] = scanlines[from + 1]!;
    out[to + 2] = scanlines[from + 2]!;
    out[to + 3] = 255;
  }
  return out;
}

/**
 * Decode a PNG to RGBA, or `null` when it uses a feature Chromium never emits.
 *
 * Null is a supported answer all the way up: the report prints a byte-level line instead of a
 * percentage, and nothing fails. A decoder that threw would turn an unusual image into a red lane,
 * which is precisely the failure mode §13.5 exists to remove.
 */
export function decodePng(bytes: Uint8Array): PngImage | null {
  const chunks = readChunks(bytes);
  if (!chunks) {
    return null;
  }
  const { header } = chunks;
  const channels = CHANNELS[header.colorType];
  if (
    channels === undefined ||
    header.bitDepth !== 8 ||
    header.interlace !== 0 ||
    header.width === 0 ||
    header.height === 0
  ) {
    return null;
  }
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(chunks.data));
  } catch {
    return null;
  }
  if (raw.length < (header.width * channels + 1) * header.height) {
    return null;
  }
  const scanlines = unfilter(raw, header.width, header.height, channels);
  return {
    height: header.height,
    pixels: toRgba(scanlines, header.width * header.height, channels),
    width: header.width,
  };
}

/**
 * Fraction of pixels that differ, 0…1, or `null` when the two images are not comparable.
 *
 * Different dimensions are NOT 100% changed — they are a different question, and the report says
 * `1920×1000 → 1600×900` instead, because "100%" would read as a repaint when it is a resize.
 * `tolerance` is a per-channel absolute delta; the captures are deterministic by S0's construction,
 * so the default is exact equality and any softening would be hiding drift.
 */
export function changedPixelRatio(a: PngImage, b: PngImage, tolerance = 0): number | null {
  if (a.width !== b.width || a.height !== b.height) {
    return null;
  }
  const total = a.width * a.height;
  let changed = 0;
  for (let i = 0; i < total; i++) {
    const at = i * 4;
    if (
      Math.abs(a.pixels[at]! - b.pixels[at]!) > tolerance ||
      Math.abs(a.pixels[at + 1]! - b.pixels[at + 1]!) > tolerance ||
      Math.abs(a.pixels[at + 2]! - b.pixels[at + 2]!) > tolerance ||
      Math.abs(a.pixels[at + 3]! - b.pixels[at + 3]!) > tolerance
    ) {
      changed += 1;
    }
  }
  return changed / total;
}
