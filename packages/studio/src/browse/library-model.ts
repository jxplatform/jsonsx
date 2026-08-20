/**
 * The Library's data model — what a project contains, and how a scan can fail.
 *
 * Two facts the Manage view it replaces could not state:
 *
 * 1. **A scan has failures.** `collectFiles` swallowed every `listDirectory` rejection in an empty
 *    catch block, so a project directory the platform could not read simply contributed nothing. A
 *    500 from the dev server and an empty `content/` produced the identical file list and the
 *    identical sentence — "No files found" — which is the lie §16 exists to end.
 *    {@link scanLibrary} returns {@link LibraryScan.failures} beside the files; the pane raises
 *    them as Problems with a Retry and refuses to call an incomplete listing empty.
 * 2. **A category has a directory.** The Manage view filtered by category and uploaded to whatever
 *    directory the active filter happened to name, which for "All" was nothing at all — the upload
 *    landed wherever `uploadAssets` defaulted. {@link uploadDirForCategory} still answers, but the
 *    pane never uploads to an unnamed destination: it asks.
 *
 * Everything here is pure over its inputs (the scan takes the platform as an argument) so the
 * 300-page acceptance case can be measured without a DOM.
 */

import { MEDIA_EXTENSIONS, extensionOf } from "../files/media-upload";
import { projectState } from "../store";
import { errorMessage } from "@jxsuite/schema/parse";
import { resolveI18n, servedLocaleOfPath } from "@jxsuite/schema/locale";
import type { ResolvedI18n } from "@jxsuite/schema/locale";
import type { ContentSectionEntry, DirEntry, StudioPlatform } from "../types";

// ─── Files ───────────────────────────────────────────────────────────────────

/** One row of the Library, whichever layout is drawing it. */
export interface LibraryFile {
  name: string;
  path: string;
  /** The content type name for a content file; the extension otherwise. */
  type: string;
  category: string;
  ext: string;
  /** Bytes, when the platform reported them. */
  size?: number | undefined;
  /** ISO timestamp, when the platform reported one. Drives the Calendar layout. */
  modified?: string | undefined;
  /**
   * The locale this file is **served as**, from `@jxsuite/schema/locale`'s `servedLocaleOfPath` —
   * the canonical tag, never the spelling on disk.
   *
   * The path answers it wherever there is a locale directory. Where there is not, `routing` does:
   * under `prefix-except-default` an unprefixed page IS the default locale's copy, and a facet that
   * could filter to French and Arabic but never to English cannot answer the question it is most
   * often asked. That reading stops at `pages/` — an unlocalized collection expands under every
   * locale's route, so calling its entries the default language would be a claim about content that
   * is in none.
   */
  locale?: string | undefined;
}

/** A directory the scan could not read. Its presence means the listing is INCOMPLETE, not empty. */
export interface ScanFailure {
  dir: string;
  error: string;
}

/** The result of one pass over the project's directories. */
export interface LibraryScan {
  files: LibraryFile[];
  failures: ScanFailure[];
}

// ─── Categories ──────────────────────────────────────────────────────────────

/** A Library category: what it is called, and the directory an upload into it lands in. */
export interface LibraryCategory {
  key: string;
  label: string;
  /** Absent for "All" — which is why "All" has no upload destination and must ask for one. */
  dir?: string;
}

export const LIBRARY_CATEGORIES: readonly LibraryCategory[] = [
  { key: "all", label: "All" },
  { dir: "pages", key: "pages", label: "Pages" },
  { dir: "layouts", key: "layouts", label: "Layouts" },
  { dir: "components", key: "components", label: "Components" },
  { dir: "content", key: "content", label: "Content" },
  { dir: "public", key: "media", label: "Media" },
];

/** The category keys, for a command's `enum` — so `library.setCategory` refuses an unknown one. */
export const LIBRARY_CATEGORY_KEYS: readonly string[] = LIBRARY_CATEGORIES.map((c) => c.key);

/** The category with this key, or undefined. */
export function libraryCategory(key: string): LibraryCategory | undefined {
  return LIBRARY_CATEGORIES.find((c) => c.key === key);
}

/**
 * The directory a drop on the Library targets while `key` is the active category.
 *
 * `undefined` for "All" and for any category without one, and the caller MUST treat that as "ask",
 * never as "use the default": an upload that lands somewhere the author did not choose is the same
 * class of surprise as a rename that silently rewrites files.
 */
export function uploadDirForCategory(key: string): string | undefined {
  return libraryCategory(key)?.dir;
}

/** Map a file path to a display category. Media files override by extension. */
export function categoryFor(dir: string, ext: string): string {
  if (ext && MEDIA_EXTENSIONS.has(ext)) {
    return "Media";
  }
  if (dir.startsWith("pages")) {
    return "Pages";
  }
  if (dir.startsWith("layouts")) {
    return "Layouts";
  }
  if (dir.startsWith("components")) {
    return "Components";
  }
  if (dir.startsWith("content")) {
    return "Content";
  }
  if (dir.startsWith("public")) {
    return "Media";
  }
  if (dir.startsWith("data")) {
    return "Content";
  }
  if (dir.startsWith("styles")) {
    return "Components";
  }
  return "Other";
}

/**
 * The content type a path belongs to, from the project's `content` section — capitalized, or null.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
export function contentTypeFor(filePath: string): string | null {
  const content = (projectState?.projectConfig?.content ?? {}) as Record<
    string,
    ContentSectionEntry
  >;
  for (const [name, entry] of Object.entries(content)) {
    if (!entry.source) {
      continue;
    }
    const prefix = entry.source.replace(/^\.\//, "").replace(/\/$/, "");
    if (filePath.startsWith(`${prefix}/`) || filePath === prefix) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return null;
}

// ─── The scan ────────────────────────────────────────────────────────────────

/** Directory names never worth walking — a `node_modules` scan is minutes, not milliseconds. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".jx", "dist", "build", ".cache"]);

/**
 * Walk one directory tree, collecting files and recording — never swallowing — what it could not
 * read. A failure at depth is reported against the directory that failed, not the root, so the
 * Problem names the path the author can act on.
 */
async function walk(
  dir: string,
  platform: Pick<StudioPlatform, "listDirectory">,
  out: LibraryFile[],
  failures: ScanFailure[],
  i18n: ResolvedI18n | null,
): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await platform.listDirectory(dir);
  } catch (error) {
    failures.push({ dir, error: errorMessage(error) });
    return;
  }
  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (entry.type === "directory") {
      if (!SKIP_DIRS.has(entry.name)) {
        subdirectories.push(entry.path);
      }
      continue;
    }
    const ext = extensionOf(entry.name);
    const category = categoryFor(entry.path, ext);
    out.push({
      category,
      ext,
      locale: servedLocaleOfPath(entry.path, i18n) ?? undefined,
      modified: entry.modified,
      name: entry.name,
      path: entry.path,
      size: entry.size,
      type: category === "Content" ? (contentTypeFor(entry.path) ?? ext ?? "file") : ext || "file",
    });
  }
  // Siblings in parallel, depth serialized per branch: the platform counts every call as in-flight,
  // So `probe.idle()` already knows the scan is running without the Library declaring a source.
  await Promise.all(subdirectories.map((sub) => walk(sub, platform, out, failures, i18n)));
}

/**
 * Scan the project's declared directories.
 *
 * Never rejects: a scan that half-worked is a real, useful answer that the caller must be able to
 * render honestly, and an exception would throw the good half away with the bad.
 */
export async function scanLibrary(
  dirs: readonly string[],
  platform: Pick<StudioPlatform, "listDirectory">,
): Promise<LibraryScan> {
  const files: LibraryFile[] = [];
  const failures: ScanFailure[] = [];
  // Resolved ONCE for the whole walk. `resolveI18n` canonicalizes every declared tag through
  // `Intl.Locale`, and a project with 300 pages would otherwise pay for that per file.
  const { i18n } = resolveI18n(projectState?.projectConfig ?? {});
  await Promise.all(dirs.map((dir) => walk(dir, platform, files, failures, i18n)));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { failures, files };
}

// ─── Filtering ───────────────────────────────────────────────────────────────

export interface LibraryFilter {
  category: string;
  query: string;
  /** A canonical tag, or "" for every language. Never a label — the labels are not unique. */
  locale?: string;
}

/**
 * Category, then text over name and path, then language. Returns the input array unchanged when
 * nothing filters.
 */
export function filterLibrary(
  files: readonly LibraryFile[],
  filter: LibraryFilter,
): readonly LibraryFile[] {
  let result = files;
  const category = libraryCategory(filter.category);
  if (category && category.key !== "all") {
    result = result.filter((f) => f.category === category.label);
  }
  const query = filter.query.trim().toLowerCase();
  if (query) {
    result = result.filter(
      (f) => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query),
    );
  }
  const locale = filter.locale?.trim();
  if (locale) {
    result = result.filter((f) => f.locale === locale);
  }
  return result;
}

// ─── Layouts ─────────────────────────────────────────────────────────────────

export const LIBRARY_LAYOUTS = ["table", "cards", "media", "calendar", "board"] as const;

export type LibraryLayout = (typeof LIBRARY_LAYOUTS)[number];

export const LIBRARY_LAYOUT_LABELS: Readonly<Record<LibraryLayout, string>> = {
  board: "Board",
  calendar: "Calendar",
  cards: "Cards",
  media: "Media",
  table: "Table",
};

/** Whether a string names a layout — the guard behind `library.setLayout`'s argument. */
export function isLibraryLayout(value: string): value is LibraryLayout {
  return (LIBRARY_LAYOUTS as readonly string[]).includes(value);
}

/** Layouts that draw a live preview per item. Table and Board draw text, and stay cheap. */
export const PREVIEW_LAYOUTS: ReadonlySet<LibraryLayout> = new Set<LibraryLayout>([
  "cards",
  "media",
]);

// ─── Derived axes (Calendar and Board) ───────────────────────────────────────

/** `YYYY-MM-DD` at the head of a filename — the dated-post convention, used when there is no mtime. */
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/**
 * The day a file belongs to, as `YYYY-MM-DD`, or null when nothing states one.
 *
 * The filename prefix wins over the filesystem's mtime: a dated post's date is authored content,
 * and mtime is a fact about the last save. A file with neither is not placed on the calendar at all
 * rather than being parked on today — the Calendar says how many it could not date.
 */
export function libraryDate(file: LibraryFile): string | null {
  const prefix = DATE_PREFIX.exec(file.name);
  if (prefix) {
    return prefix[1]!;
  }
  if (file.modified) {
    const parsed = new Date(file.modified);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return null;
}

/**
 * The locales this project DECLARES, canonical and in declaration order — the value space of the
 * Library's language facet and of `library.setLocale`'s `enum`.
 *
 * Read at call time rather than cached: `projectState` is a plain binding replaced wholesale on a
 * project switch, so a cached list would describe the project before last.
 */
export function projectLocales(): readonly string[] {
  return resolveI18n(projectState?.projectConfig ?? {}).i18n?.locales ?? [];
}

/**
 * The locales actually PRESENT among these files, in the project's declaration order.
 *
 * Ordered by the project and not by the scan for the reason {@link groupByCategory} orders its
 * columns by {@link LIBRARY_CATEGORIES}: a facet whose options reshuffle when a file is added is a
 * facet nobody can build muscle memory for. Declaration order also puts the default locale first,
 * because {@link resolveI18n} guarantees it is `locales[0]`.
 *
 * Only declared tags can appear — `localeOfPath` matches nothing else — so filtering the
 * declaration through the presence set loses no file.
 */
export function libraryLocales(files: readonly LibraryFile[]): string[] {
  const present = new Set<string>();
  for (const file of files) {
    if (file.locale) {
      present.add(file.locale);
    }
  }
  return projectLocales().filter((tag) => present.has(tag));
}

/** Calendar buckets, newest day first, plus the files no date could be derived for. */
export function groupByDate(files: readonly LibraryFile[]): {
  days: { date: string; files: LibraryFile[] }[];
  undated: LibraryFile[];
} {
  const byDay = new Map<string, LibraryFile[]>();
  const undated: LibraryFile[] = [];
  for (const file of files) {
    const date = libraryDate(file);
    if (date === null) {
      undated.push(file);
      continue;
    }
    const bucket = byDay.get(date);
    if (bucket) {
      bucket.push(file);
    } else {
      byDay.set(date, [file]);
    }
  }
  const days = [...byDay.entries()]
    .map(([date, dayFiles]) => ({ date, files: dayFiles }))
    .toSorted((a, b) => b.date.localeCompare(a.date));
  return { days, undated };
}

/** Board columns — one per category present, in the Library's own category order, then the rest. */
export function groupByCategory(
  files: readonly LibraryFile[],
): { group: string; files: LibraryFile[] }[] {
  const byGroup = new Map<string, LibraryFile[]>();
  for (const file of files) {
    const bucket = byGroup.get(file.category);
    if (bucket) {
      bucket.push(file);
    } else {
      byGroup.set(file.category, [file]);
    }
  }
  const order = LIBRARY_CATEGORIES.map((c) => c.label);
  return [...byGroup.entries()]
    .map(([group, groupFiles]) => ({ files: groupFiles, group }))
    .toSorted((a, b) => {
      const ai = order.indexOf(a.group);
      const bi = order.indexOf(b.group);
      if (ai === bi) {
        return a.group.localeCompare(b.group);
      }
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    });
}
