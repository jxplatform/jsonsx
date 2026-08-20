/**
 * The `Feed` section-owner class.
 *
 * Three capabilities, and the split between two of them is the interesting part. `emit` derives
 * files from loaded content and runs after every page has been written; `head` derives the `<link
 * rel="alternate">` discovery tag from **configuration** and must run before the first page is
 * built. A feed needs both, which is why `head` exists (specs/extensions.md §8.6).
 *
 * @docs framework/site/feeds
 */

import { canonicalizeLocale, localeUrlPrefix, resolveI18n } from "@jxsuite/schema/locale";
import type { ResolvedI18n } from "@jxsuite/schema/locale";
import type { ContentLoaderEntry, JxHeadEntry, ProjectConfig } from "@jxsuite/schema/types";
import { atomUrl, renderAtom } from "./atom.ts";
import { jsonFeedUrl, renderJsonFeed } from "./json-feed.ts";
import {
  entryToItem,
  feedPath,
  feedUpdated,
  normalizeFeedConfig,
  paginate,
  sortItems,
} from "./shared.ts";
import type { NormalizedFeed, NormalizedFeedConfig } from "./shared.ts";

interface EmitContext {
  projectConfig?: ProjectConfig;
  root?: string;
  sections?: Record<string, unknown>;
  routes?: unknown[];
}

interface HeadContext {
  projectConfig?: ProjectConfig;
  root?: string;
}

const MEDIA_TYPES = { atom: "application/atom+xml", json: "application/feed+json" } as const;

function siteUrlOf(projectConfig: ProjectConfig | undefined): string | null {
  const url = projectConfig?.url;
  return typeof url === "string" && url !== "" ? url : null;
}

/**
 * The locales a feed is published in, or `[]` when it is published once.
 *
 * A feed says what language it carries, and a collection spread over one directory per locale
 * (site-architecture.md §13.3) carries several — so it is several feeds. One feed mixing three
 * languages is worse than it sounds: a reader subscribes to it in theirs and receives every post
 * three times, twice in a language they do not read.
 *
 * Read from the collection's `source`, because `head` has to answer this before any content is
 * loaded and configuration is all it has. That the `content` section belongs to another extension
 * is not a coupling this introduces — a feed already names a collection out of it.
 *
 * @param {ProjectConfig | undefined} projectConfig
 * @param {string} collection
 * @returns {{ i18n: ResolvedI18n | null; locales: string[] }}
 */
function feedLocales(
  projectConfig: ProjectConfig | undefined,
  collection: string,
): { i18n: ResolvedI18n | null; locales: string[] } {
  const { i18n } = resolveI18n(projectConfig ?? {});
  const content = (projectConfig as { content?: Record<string, { source?: unknown }> } | undefined)
    ?.content;
  const source = content?.[collection]?.source;
  const localized = typeof source === "string" && source.includes("{locale}");
  return { i18n, locales: i18n !== null && localized ? i18n.locales : [] };
}

/** One locale's view of a feed: its own URL space, its own language. */
function localeVariant(feed: NormalizedFeed, locale: string, i18n: ResolvedI18n | null) {
  const prefix = localeUrlPrefix(locale, i18n);
  return {
    ...feed,
    basePath: `${prefix}${feed.basePath}`,
    language: locale,
    output: `${prefix}${feed.output}`,
  };
}

export const Feed = {
  /** Normalize the `feed` section into `_project.feed`. */
  projectData(sectionValue: unknown, ctx?: HeadContext): NormalizedFeedConfig {
    return normalizeFeedConfig(sectionValue, ctx?.projectConfig?.defaults?.lang);
  },

  /**
   * The auto-discovery links.
   *
   * Pure configuration, which is exactly why this can run before content loads — a feed's URL comes
   * from its `output`, not from its entries.
   */
  head(sectionValue: unknown, ctx: HeadContext): JxHeadEntry[] {
    const siteUrl = siteUrlOf(ctx.projectConfig);
    if (siteUrl === null) {
      return [];
    }
    const config = normalizeFeedConfig(sectionValue, ctx.projectConfig?.defaults?.lang);
    const entries: JxHeadEntry[] = [];
    for (const feed of Object.values(config)) {
      const { i18n, locales } = feedLocales(ctx.projectConfig, feed.collection);
      /*
       * One link per language, each carrying `hreflang`. `head` runs before routing and cannot know
       * which locale the page it lands on is in, so it advertises all of them and lets the client
       * choose — which is what `hreflang` on an `alternate` link is for.
       */
      const published =
        locales.length > 0 ? locales.map((l) => localeVariant(feed, l, i18n)) : [feed];
      for (const variant of published) {
        for (const format of variant.formats) {
          const href =
            format === "atom"
              ? atomUrl(siteUrl, variant.output)
              : jsonFeedUrl(siteUrl, variant.output);
          entries.push({
            attributes: {
              href,
              ...(variant.language !== null && locales.length > 0
                ? { hreflang: variant.language }
                : {}),
              rel: "alternate",
              title: variant.title === "" ? "Feed" : variant.title,
              type: MEDIA_TYPES[format],
            },
            tagName: "link",
          });
        }
      }
    }
    return entries;
  },

  /** Serialize every configured feed, plus its RFC 5005 archives when enabled. */
  emit(sectionValue: unknown, ctx: EmitContext): { path: string; content: string }[] {
    const siteUrl = siteUrlOf(ctx.projectConfig);
    if (siteUrl === null) {
      console.warn("@jxsuite/feed: `url` is not set in project.json — feeds need absolute links.");
      return [];
    }
    const config = normalizeFeedConfig(sectionValue, ctx.projectConfig?.defaults?.lang);
    const content = ctx.sections?.content as Map<string, ContentLoaderEntry[]> | undefined;
    const trailingSlash = String(ctx.projectConfig?.build?.trailingSlash ?? "always");
    const files: { path: string; content: string }[] = [];

    for (const [key, feed] of Object.entries(config)) {
      const entries = content?.get(feed.collection);
      if (!entries) {
        console.warn(
          `@jxsuite/feed: feed "${key}" names collection "${feed.collection}", which is not a ` +
            "loaded content collection — skipped",
        );
        continue;
      }
      const { i18n, locales } = feedLocales(ctx.projectConfig, feed.collection);
      if (locales.length === 0) {
        files.push(...renderFeed(feed, entries, siteUrl, trailingSlash));
        continue;
      }
      /*
       * One feed per language, each holding only that language's entries. An entry with no locale
       * belongs to none of them — it cannot happen for a `{locale}` source, and inventing a home
       * for it would publish it in every language at once.
       */
      for (const locale of locales) {
        const own = entries.filter((e) => canonicalizeLocale(e._meta?.locale) === locale);
        if (own.length > 0) {
          files.push(...renderFeed(localeVariant(feed, locale, i18n), own, siteUrl, trailingSlash));
        }
      }
    }
    return files;
  },
};

function renderFeed(
  feed: NormalizedFeed,
  entries: readonly ContentLoaderEntry[],
  siteUrl: string,
  trailingSlash: string,
): { path: string; content: string }[] {
  const items = sortItems(entries.map((e) => entryToItem(e, feed, siteUrl, trailingSlash)));
  const files: { path: string; content: string }[] = [];
  const { archives, current } = feed.archive
    ? paginate(items, feed.pageSize)
    : { archives: [], current: items.slice(0, feed.pageSize) };

  /*
   * `fh:complete` is only true when the document really holds everything — no archives AND nothing
   * trimmed by pageSize. Claiming completeness while entries are missing is worse than saying
   * nothing, because a reader believes it.
   */
  const complete = archives.length === 0 && current.length === items.length;

  for (const format of feed.formats) {
    const url = format === "atom" ? atomUrl : jsonFeedUrl;
    if (format === "atom") {
      files.push({
        content: renderAtom({
          complete,
          feed,
          items: current,
          selfUrl: url(siteUrl, feed.output),
          siteUrl,
          updated: feedUpdated(items),
          ...(archives.length > 0
            ? { prevArchiveUrl: url(siteUrl, feed.output, archives.length - 1) }
            : {}),
        }),
        path: feedPath(feed.output, "xml"),
      });
      // Archives run oldest-first, so `prev-archive` walks backwards through time.
      for (const [i, page] of archives.entries()) {
        files.push({
          content: renderAtom({
            currentUrl: url(siteUrl, feed.output),
            feed,
            items: page,
            selfUrl: url(siteUrl, feed.output, i),
            siteUrl,
            updated: feedUpdated(page),
            ...(i > 0 ? { prevArchiveUrl: url(siteUrl, feed.output, i - 1) } : {}),
            nextArchiveUrl:
              i < archives.length - 1
                ? url(siteUrl, feed.output, i + 1)
                : url(siteUrl, feed.output),
          }),
          path: feedPath(feed.output, "xml", i),
        });
      }
    } else {
      files.push({
        content: renderJsonFeed({
          feed,
          items: current,
          selfUrl: url(siteUrl, feed.output),
          siteUrl,
        }),
        path: feedPath(feed.output, "json"),
      });
    }
  }
  return files;
}
