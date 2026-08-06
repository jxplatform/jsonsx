/**
 * Media metadata — what a file IS, for surfaces that show media rather than resolve it.
 *
 * Three facts, and each has an "unknown" that is not a zero:
 *
 * - **Size and modified time** come from the directory listing the caller already performed. A media
 *   surface enumerates a directory to draw itself, so `seedMediaMeta` folds those entries in for
 *   free and {@link loadMediaMeta} is the fallback for a path nobody enumerated.
 * - **Pixel dimensions** are OPPORTUNISTIC. There is no stat that returns them and no decoder in the
 *   shell, so the only honest source is an `<img>` that already loaded — which every media surface
 *   renders anyway. {@link recordImageSize} is how that surface hands the number back, and until
 *   one does, the dimensions are `null` and the summary simply omits them. Downloading the file a
 *   second time to measure it would be a network request per thumbnail for a line of text.
 *
 * A missing number is `null` everywhere, never `0`. `0 × 0` and `0 B` are things a real file can
 * almost be, so they must not double as "we did not find out" — the same rule
 * `services/references.ts` applies to a count it cannot answer.
 *
 * The cache is dropped wholesale by {@link invalidateMediaMeta}, wired to the same post-upload
 * invalidation the media picker's listing uses. There is no TTL: a size that expires on a timer is
 * wrong at an unannounced moment.
 *
 * @docs studio/projects/media
 */

import { getPlatform } from "../platform";
import { baseName, dirName, normalizeProjectPath } from "./media-paths";
import { extensionOf, mediaKind } from "./media-upload";
import type { AssetKind } from "./media-upload";
import type { DirEntry } from "../types";

/** Everything a media surface can say about one file without opening it. */
export interface MediaMeta {
  /** Project-relative, forward-slashed. */
  path: string;
  /** Filename only. */
  name: string;
  /** Lowercased extension including the dot, or `""`. */
  ext: string;
  /** What kind of element it wants to become — the same classification `uploadAssets` records. */
  kind: AssetKind;
  /** Bytes on disk, or null when the listing did not say. */
  bytes: number | null;
  /** ISO modification time, or null when the listing did not say. */
  modified: string | null;
  /** Intrinsic width in CSS pixels, or null until an `<img>` for this file has loaded. */
  width: number | null;
  /** Intrinsic height in CSS pixels, or null until an `<img>` for this file has loaded. */
  height: number | null;
}

/** Settled metadata, by project-relative path. */
const settled = new Map<string, MediaMeta>();
/** In-flight listings, so N surfaces asking about one path share one round trip. */
const inFlight = new Map<string, Promise<MediaMeta>>();
/**
 * Dimensions reported by a loaded `<img>`, kept beside the cache rather than inside it.
 *
 * A surface can measure a thumbnail before anyone asks for its size — and a `loadMediaMeta` that
 * landed afterwards would otherwise overwrite the one fact that cost a decode to learn.
 */
const measured = new Map<string, { width: number; height: number }>();

/** Build a meta record from a path and whatever the listing knew about it. */
function metaFrom(path: string, entry: DirEntry | undefined): MediaMeta {
  const name = baseName(path);
  const dims = measured.get(path);
  return {
    bytes: typeof entry?.size === "number" ? entry.size : null,
    ext: extensionOf(name),
    height: dims?.height ?? null,
    kind: mediaKind({ name }),
    modified: entry?.modified ?? null,
    name,
    path,
    width: dims?.width ?? null,
  };
}

/**
 * The metadata known right now, WITHOUT starting a request.
 *
 * Templates call this: a lit render is synchronous, and a render that listed a directory every time
 * it ran would re-list on its own repaint.
 */
export function peekMediaMeta(path: string): MediaMeta | null {
  return settled.get(normalizeProjectPath(path)) ?? null;
}

/**
 * Fold a directory listing into the cache — the cheap path, for a surface that just enumerated.
 *
 * Only file entries are recorded, and an entry never overwrites a settled record: the listing that
 * arrives second is not more truthful than the one that arrived first, and replacing the record
 * would drop measured dimensions from the object templates are already holding.
 */
export function seedMediaMeta(entries: Iterable<DirEntry>): void {
  for (const entry of entries) {
    if (entry.type !== "file") {
      continue;
    }
    const path = normalizeProjectPath(entry.path);
    if (!settled.has(path)) {
      settled.set(path, metaFrom(path, entry));
    }
  }
}

/**
 * Ask for one file's metadata, or join the ask already in flight.
 *
 * Never rejects. A directory that cannot be listed yields a record whose numbers are `null` — "we
 * do not know how big it is" is a renderable answer, and a thrown error at this altitude would only
 * be caught and turned back into one by every caller.
 */
export async function loadMediaMeta(path: string): Promise<MediaMeta> {
  const key = normalizeProjectPath(path);
  const done = settled.get(key);
  if (done) {
    return done;
  }
  const running = inFlight.get(key);
  if (running) {
    return running;
  }
  const pending = (async (): Promise<MediaMeta> => {
    let entry: DirEntry | undefined;
    try {
      const listing = await getPlatform().listDirectory(dirName(key));
      entry = listing.find((item) => normalizeProjectPath(item.path) === key);
    } catch {
      // Unreadable or not yet created — the size stays unknown rather than becoming zero.
      entry = undefined;
    }
    return metaFrom(key, entry);
  })();
  inFlight.set(key, pending);
  const meta = await pending;
  inFlight.delete(key);
  settled.set(key, meta);
  return meta;
}

/**
 * Record the intrinsic size of a file whose `<img>` has loaded.
 *
 * @returns Whether this was new information — the caller repaints only when it was, so a template
 *   that re-renders its thumbnails (and re-fires their `load` from cache) does not loop.
 */
export function recordImageSize(path: string, width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) {
    return false; // A broken or still-decoding image reports 0 — that is not a measurement.
  }
  const key = normalizeProjectPath(path);
  const known = measured.get(key);
  if (known && known.width === width && known.height === height) {
    return false;
  }
  measured.set(key, { height, width });
  const meta = settled.get(key);
  if (meta) {
    settled.set(key, { ...meta, height, width });
  }
  return true;
}

/** Drop every cached record and measurement. Called wherever the media listing is invalidated. */
export function invalidateMediaMeta(): void {
  settled.clear();
  measured.clear();
}

/** `84 KB`, `1.2 MB`, `903 B` — one significant fraction, because this is a caption. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The one-line caption a media surface shows: `1200 × 800 · 84 KB`.
 *
 * Unknown facts are omitted rather than rendered as a placeholder, so the line shortens instead of
 * filling with dashes. It is `""` when nothing at all is known, which a template renders as
 * nothing.
 */
export function mediaMetaSummary(meta: MediaMeta | null): string {
  if (!meta) {
    return "";
  }
  const parts: string[] = [];
  if (meta.width !== null && meta.height !== null) {
    parts.push(`${meta.width} × ${meta.height}`);
  }
  if (meta.bytes !== null) {
    parts.push(formatBytes(meta.bytes));
  }
  return parts.join(" · ");
}
