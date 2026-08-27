/**
 * Collection-match — the ONE answer to "which content collection owns this path".
 *
 * Three matchers already existed and disagreed: `utils/studio-utils.ts`'s `findContentTypeSchema`,
 * `grid/sources/content-source.ts`'s `collectionInfo` and `browse/library-model.ts`'s
 * `contentTypeFor`. Each was right about the question it was written for and wrong about the
 * others', which was tolerable while the consumers were a form and a grid. It stopped being
 * tolerable when the Files tree began asking, because a mismatch there does not draw the wrong
 * field — it CONSTRAINS or REROUTES a creation, and both are wrong answers the author cannot see.
 *
 * Four things this states that no predecessor did:
 *
 * 1. **A locale segment is one of the project's DECLARED locales** wherever it declares any. The bare
 *    `[^/]+` wildcard binds `content/exhibitions/images` — the co-located media directory
 *    `site-architecture.md` §6.5 blesses — as if it were a locale root. The wildcard survives only
 *    as the fallback for a project that declares a `{locale}` source and no `i18n` section at all,
 *    where it is the sole thing that can match.
 * 2. **`dir` is the directory that MATCHED**, not the declared `source`. `collectionInfo` hands back a
 *    literal `content/exhibitions/{locale}`, which is a path nobody has; a caller that creates a
 *    file there creates a directory named `{locale}`.
 * 3. **The longest source wins**, not the first declared. With sources `./content/` and
 *    `./content/blog/`, a file in the latter belongs to the latter.
 * 4. **An unregistered format is `null`, and says so.** `ext` falling back to `.json` when the
 *    declared format class is missing produces a locked picker asserting an extension the
 *    collection does not use — a stated lie plus an enforced refusal, which is worse than no
 *    constraint at all.
 *
 * Pure over `projectState.projectConfig` and the format registry, so every rule is assertable with
 * no DOM and no platform.
 */

import { defaultContentFormat, formatByName } from "../format/format-host";
import { projectState } from "../store";
import { resolveI18n } from "@jxsuite/schema/locale";
import type { ContentSectionEntry } from "../types";
import type { ProjectConfig } from "@jxsuite/schema/types";

/** The placeholder a localized `source` carries, standing for one directory per declared locale. */
export const LOCALE_PLACEHOLDER = "{locale}";

/** What a path's collection is, and everything a caller needs in order to act on it. */
export interface CollectionMatch {
  name: string;
  def: ContentSectionEntry;
  /**
   * The extension this collection's entries carry, or `null` when its declared `format` names a
   * class the project has not registered. Never a silent `.json`.
   */
  ext: string | null;
  /** The declared-but-missing format name behind a `null` `ext`, for the message that says so. */
  unresolvedFormat: string | null;
  /** The REAL directory that matched: `{locale}` substituted, a subdirectory preserved. */
  dir: string;
  /** True when `dir` is the collection's own source root rather than a directory beneath it. */
  isSourceRoot: boolean;
  /** True when `source` names a single file (a CSV catalogue) — its entries are rows, not files. */
  fileBacked: boolean;
}

/** Escape a literal for embedding in a RegExp — `sites/jxsuite.com` ships `source: "../../docs"`. */
function escapeLiteral(part: string): string {
  return part.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Normalise a project-relative path: forward slashes, no `./` prefix, no trailing slash. */
function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The config a lookup reads: the caller's, or the open project's. */
function configOf(config: ProjectConfig | null | undefined): ProjectConfig | null {
  return config ?? (projectState?.projectConfig as ProjectConfig | null | undefined) ?? null;
}

/** The `content` section of a config, or an empty one. */
function contentSection(config: ProjectConfig | null): Record<string, ContentSectionEntry> {
  return (config?.content ?? {}) as Record<string, ContentSectionEntry>;
}

/**
 * The locales a `{locale}` segment may be, canonicalised — or `null` when the project declares none
 * and the segment must fall back to matching anything.
 */
function declaredLocales(config: ProjectConfig | null): string[] | null {
  const locales = resolveI18n(config ?? {}).i18n?.locales ?? [];
  return locales.length > 0 ? [...locales] : null;
}

/**
 * Whether `source` names a single file rather than a directory.
 *
 * A trailing slash settles it outright; otherwise the BASENAME must carry an extension. Testing the
 * whole string — which `collectionDirs` does — calls `./content/v1.2/` a file, and testing merely
 * for a dot calls `../../docs` one.
 */
function isFileBacked(source: string): boolean {
  if (source.endsWith("/")) {
    return false;
  }
  const base = source.slice(source.lastIndexOf("/") + 1);
  return /\.[a-z\d]+$/i.test(base);
}

/**
 * The extension a collection's entries carry, and the format name that failed when there is none.
 *
 * `json` is the one native collection shape (`site-architecture.md` §6.2) and has no format class
 * to ask; a collection declaring no format at all is resolved from the source extension by the
 * loader, which `defaultContentFormat()` approximates. Anything else must resolve through the
 * registry, and when it does not the answer is `null` plus the name, never a fallback.
 */
function resolveExt(def: ContentSectionEntry): Pick<CollectionMatch, "ext" | "unresolvedFormat"> {
  if (def.format === "json") {
    return { ext: ".json", unresolvedFormat: null };
  }
  if (def.format === undefined || def.format === "") {
    return { ext: defaultContentFormat()?.extensions[0] ?? ".json", unresolvedFormat: null };
  }
  const format = formatByName(def.format);
  return format?.extensions[0] === undefined
    ? { ext: null, unresolvedFormat: def.format }
    : { ext: format.extensions[0], unresolvedFormat: null };
}

/**
 * The pattern a declared `source` matches paths with — the root itself, or anything beneath it.
 *
 * Locale segments come from the project's own `i18n.locales`, which is what keeps
 * `content/exhibitions/images` out; the bare wildcard survives only when the project declares no
 * locales at all, where it is the sole thing that can match a `{locale}` source. Case-insensitive,
 * because a `fr-FR` declaration and an `fr-fr` directory are the same locale — and because APFS and
 * NTFS are case-insensitive too.
 */
function sourcePattern(source: string, locales: string[] | null): RegExp {
  const segment =
    locales === null ? "[^/]+" : `(?:${locales.map((locale) => escapeLiteral(locale)).join("|")})`;
  const body = normalize(source)
    .split(LOCALE_PLACEHOLDER)
    .map((part) => escapeLiteral(part))
    .join(segment);
  return new RegExp(`^${body}(?:/|$)`, "i");
}

/**
 * The matched source ROOT inside `target`, or null.
 *
 * Returned rather than merely tested, because `dir` must be the real directory and `isSourceRoot`
 * must know where the root ended — neither is recoverable from a `source` that still carries a
 * placeholder.
 */
function matchedRoot(source: string, target: string, locales: string[] | null): string | null {
  const hit = sourcePattern(source, locales).exec(target);
  if (!hit) {
    return null;
  }
  // The match includes the trailing "/" when the target is beneath the root; trim it back.
  return hit[0].replace(/\/$/, "");
}

/**
 * How specific a source is, for "longest wins". Measured on the LITERAL text with the placeholder
 * removed: two sources cannot be compared on their expansions, because a localized one expands
 * differently per locale.
 */
function sourceWeight(source: string): number {
  return normalize(source).replaceAll(LOCALE_PLACEHOLDER, "").length;
}

/**
 * The collection whose source tree contains `dir` — the source root itself, or any directory under
 * it.
 *
 * Entry discovery is RECURSIVE (`Markdown.discover` walks with `readdirSync(recursive: true)`, and
 * the grid's `listEntryFiles` walks subdirectories), so a document in `content/posts/2026/` is an
 * entry of `posts`. `isSourceRoot` is what lets a caller treat the two depths differently without
 * consulting a second matcher.
 *
 * File-backed collections are skipped: a CSV catalogue's directory is an ordinary directory, and
 * its entries are rows rather than files. {@link collectionForFile} answers for the catalogue
 * itself.
 *
 * @param dir - Project-relative directory. `"."` is the project root.
 * @param config - Config to read; defaults to the open project's.
 * @returns The most specific matching collection, or null.
 */
export function collectionForDirectory(
  dir: string | null | undefined,
  config?: ProjectConfig | null,
): CollectionMatch | null {
  if (dir === null || dir === undefined || dir === "") {
    return null;
  }
  const resolved = configOf(config);
  const locales = declaredLocales(resolved);
  const target = normalize(dir);
  let best: CollectionMatch | null = null;
  let bestWeight = -1;
  for (const [name, def] of Object.entries(contentSection(resolved))) {
    const { source } = def;
    if (source === undefined || source === "" || isFileBacked(source)) {
      continue;
    }
    const weight = sourceWeight(source);
    if (weight <= bestWeight) {
      continue;
    }
    const root = matchedRoot(source, target, locales);
    if (root === null) {
      continue;
    }
    best = {
      def,
      dir: target,
      fileBacked: false,
      isSourceRoot: target.length === root.length,
      name,
      ...resolveExt(def),
    };
    bestWeight = weight;
  }
  return best;
}

/**
 * The collection a FILE belongs to: the collection of the directory holding it, or — for a
 * file-backed collection — the one whose `source` the file IS.
 *
 * The file's own extension is NOT consulted, deliberately. A `.json` sitting in a Markdown
 * collection's folder is still that collection's business: it is exactly the file a convert must
 * refuse to produce, and answering "no collection" for it is how it would slip through.
 *
 * @param path - Project-relative file path.
 * @param config - Config to read; defaults to the open project's.
 * @returns The collection, or null.
 */
export function collectionForFile(
  path: string | null | undefined,
  config?: ProjectConfig | null,
): CollectionMatch | null {
  if (path === null || path === undefined || path === "") {
    return null;
  }
  const resolved = configOf(config);
  const target = normalize(path);
  const lower = target.toLowerCase();
  for (const [name, def] of Object.entries(contentSection(resolved))) {
    const { source } = def;
    if (source === undefined || source === "" || !isFileBacked(source)) {
      continue;
    }
    const src = normalize(source).toLowerCase();
    if (lower === src || lower.endsWith(`/${src}`)) {
      return {
        def,
        dir: target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : ".",
        fileBacked: true,
        isSourceRoot: false,
        name,
        ...resolveExt(def),
      };
    }
  }
  return collectionForDirectory(
    target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : ".",
    resolved,
  );
}
