/**
 * Group an image's responsive derivatives back into one family, and pick the member to keep.
 *
 * A CMS publishes one photograph as a dozen files. WordPress alone emits `-300x200`, `-768x512`,
 * `-1024x683`, `-1536x1025`, `-2048x1366` and `-scaled` beside the upload, and every one of them
 * appears in the `srcset` of every `<img>` that uses it. The importer enqueued each candidate as an
 * independent asset, so a clone of a 451-image site downloaded 2,446 files and 427 MB, and the
 * emitted markup carried the whole derivative ladder forward.
 *
 * That is the wrong shape twice over. It is large, and it hands the compiler a `srcset` it did not
 * build and cannot reason about — while `image-transform.ts` caps its own ladder at the source
 * file's width, so an `<img src>` pointing at a `-300x200` derivative is a permanent quality
 * ceiling rather than merely a wasted byte.
 *
 * So the importer keeps ONE member per family and lets the compiler regenerate sizes from it.
 *
 * Two rules make this safe on a real site:
 *
 * 1. **The key comes from the source URL, never from the written filename.** `sanitizeFilename`
 *    truncates a long name to 96 characters, which cuts the `-WxH` marker off the end — five
 *    resolutions of one image would land as five unrelated families.
 * 2. **The winner is always a URL the page actually referenced.** 120 of the 451 families on the
 *    reference corpus have no undecorated member at all, because WordPress serves only
 *    `-scaled.jpg` once an upload passes its threshold. Synthesising the bare name and fetching it
 *    would 404 on those, and a failed download leaves the remote URL in the markup — the clone then
 *    serves images from the host it cloned. Taking the largest real candidate cannot fail that
 *    way.
 */

import type { DiscoveredAsset } from "./asset-collect.ts";

/** Sources whose URLs are responsive variants of one image. A CSS background is not one. */
const FAMILY_SOURCES = new Set(["img-src", "img-srcset", "source-srcset", "picture-source"]);

/** `name-1024x683.jpg` → the `1024x683` marker, and where it starts. */
const DIMENSION_SUFFIX = /-(\d{1,5})x(\d{1,5})$/;

/** WordPress's marker for "the original was too big, this is the working copy". */
const SCALED_SUFFIX = /-scaled$/;

interface ParsedName {
  /** The stem with any `-WxH` and `-scaled` markers removed. */
  stem: string;
  /** Pixel area of the `-WxH` marker, or null when there is none. */
  area: number | null;
  /** Whether the name carried `-scaled`. */
  scaled: boolean;
}

function splitExtension(pathname: string): { base: string; ext: string } {
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  return dot > slash
    ? { base: pathname.slice(0, dot), ext: pathname.slice(dot) }
    : { base: pathname, ext: "" };
}

/**
 * Strip the derivative markers from a pathname's final segment.
 *
 * Order matters: WordPress writes `photo-scaled-768x512.jpg`, so the dimensions come off first and
 * `-scaled` second. Doing it the other way leaves `-768x512` welded to the stem and splits the
 * family.
 */
function parseName(pathname: string): ParsedName {
  const { base } = splitExtension(pathname);
  let stem = base;
  let area: number | null = null;

  const dimensions = stem.match(DIMENSION_SUFFIX);
  if (dimensions) {
    area = Number(dimensions[1]) * Number(dimensions[2]);
    stem = stem.slice(0, dimensions.index);
  }

  const scaled = SCALED_SUFFIX.test(stem);
  if (scaled) {
    stem = stem.replace(SCALED_SUFFIX, "");
  }

  return { area, scaled, stem };
}

/**
 * The identity two derivatives of one image share.
 *
 * Origin and directory are part of it — two sites can both serve `hero.jpg`, and WordPress's
 * `/uploads/<year>/<month>/` layout means the same basename recurs legitimately. The query string
 * is not: a cache-buster is not a different image. A URL that will not parse is its own family,
 * which is the conservative answer (it is kept, not merged with something it may not match).
 */
export function familyKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const { ext } = splitExtension(parsed.pathname);
  const { stem } = parseName(parsed.pathname);
  return `${parsed.origin}${stem}${ext.toLowerCase()}`;
}

/**
 * Pick the member of a family to keep.
 *
 * Ranked: an undecorated name beats everything, because it is the upload itself; otherwise the
 * largest `-WxH` wins, and a `-scaled` copy is preferred to a small explicit crop only when nothing
 * else is left. Ties break on the URL string so a crawl is reproducible.
 *
 * @param {readonly string[]} candidates - Absolute URLs, all of one family, non-empty
 * @returns {string}
 */
export function chooseOriginal(candidates: readonly string[]): string {
  const ranked = candidates.map((url) => {
    let pathname: string;
    try {
      ({ pathname } = new URL(url));
    } catch {
      pathname = url;
    }
    const { area, scaled } = parseName(pathname);
    // Undecorated first, then scaled-only, then explicit crops largest-first.
    const tier = area === null ? (scaled ? 1 : 0) : 2;
    return { area: area ?? 0, tier, url };
  });

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.area !== b.area) {
      return b.area - a.area;
    }
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });

  return ranked[0]!.url;
}

export interface ImageFamilyPlan {
  /** The assets to actually download — one per image family, plus every non-family asset. */
  keep: DiscoveredAsset[];
  /**
   * Dropped URL → the URL kept in its place.
   *
   * The caller replays this over the download's `rewriteMap` so a reference to any derivative still
   * resolves, to the one file that was written.
   */
  alias: Map<string, string>;
}

/**
 * Reduce a discovered asset list to one member per image family.
 *
 * Only `<img>`/`<source>` URLs take part. A CSS background, a font and a favicon are each kept as
 * found: a background is authored at one size, and merging two of them on a coincidental name match
 * would silently swap an image the stylesheet asked for.
 *
 * @param {readonly DiscoveredAsset[]} assets
 * @returns {ImageFamilyPlan}
 */
export function planImageFamilies(assets: readonly DiscoveredAsset[]): ImageFamilyPlan {
  const families = new Map<string, string[]>();
  for (const asset of assets) {
    if (!FAMILY_SOURCES.has(asset.source)) {
      continue;
    }
    const key = familyKey(asset.url);
    families.set(key, [...(families.get(key) ?? []), asset.url]);
  }

  const winners = new Map<string, string>();
  for (const [key, urls] of families) {
    winners.set(key, chooseOriginal(urls));
  }

  const alias = new Map<string, string>();
  const keep: DiscoveredAsset[] = [];
  const taken = new Set<string>();

  for (const asset of assets) {
    if (!FAMILY_SOURCES.has(asset.source)) {
      keep.push(asset);
      continue;
    }
    const winner = winners.get(familyKey(asset.url))!;
    if (asset.url === winner) {
      if (!taken.has(winner)) {
        taken.add(winner);
        keep.push(asset);
      }
      continue;
    }
    alias.set(asset.url, winner);
  }

  return { alias, keep };
}

/**
 * Point every dropped derivative at the file its family actually wrote.
 *
 * The download only ever saw one member per family, so the map it returns has one entry per family.
 * Markup still refers to whichever rung it was authored against, and an unresolved reference is not
 * merely a broken image: `asset-rewrite.ts` leaves a URL it cannot resolve untouched, so the built
 * clone would go on serving that image from the site it was cloned from.
 *
 * @param {Map<string, string>} rewriteMap - Download result, mutated in place
 * @param {ReadonlyMap<string, string>} alias - Dropped URL to kept URL, from
 *   {@link planImageFamilies}
 * @returns {number} How many references were reconnected
 */
export function applyFamilyAliases(
  rewriteMap: Map<string, string>,
  alias: ReadonlyMap<string, string>,
): number {
  let reconnected = 0;
  for (const [dropped, kept] of alias) {
    const local = rewriteMap.get(kept);
    if (local !== undefined) {
      rewriteMap.set(dropped, local);
      reconnected += 1;
    }
  }
  return reconnected;
}
