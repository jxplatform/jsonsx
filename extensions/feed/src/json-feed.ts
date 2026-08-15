/**
 * JSON Feed 1.1.
 *
 * The same model as the Atom serializer, in the format a reader that would rather not parse XML
 * asks for. It carries no RFC 5005 links: JSON Feed has its own `next_url` pagination and mixing
 * the two conventions in one document would be worse than offering the archives in Atom alone.
 */

import { feedPath } from "./shared.ts";
import type { FeedItem, NormalizedFeed } from "./shared.ts";

const VERSION = "https://jsonfeed.org/version/1.1";

export interface JsonFeedPage {
  siteUrl: string;
  feed: NormalizedFeed;
  items: readonly FeedItem[];
  selfUrl: string;
  /** JSON Feed's own pagination: the next, older page. */
  nextUrl?: string;
}

interface JsonFeedItem {
  id: string;
  url: string;
  title: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  date_published?: string;
  date_modified?: string;
  authors?: { name: string }[];
}

export function renderJsonFeed(page: JsonFeedPage): string {
  const { feed, items, siteUrl } = page;
  const doc: Record<string, unknown> = {
    description: feed.description === "" ? undefined : feed.description,
    feed_url: page.selfUrl,
    home_page_url: new URL(feed.basePath, siteUrl).href,
    // BCP 47, and the one place a feed states the language of what it carries.
    language: feed.language ?? undefined,
    next_url: page.nextUrl,
    title: feed.title === "" ? "Feed" : feed.title,
    version: VERSION,
    // Authors is the 1.1 spelling; `author` was 1.0 and is deprecated.
    ...(feed.author?.name === undefined ? {} : { authors: [{ name: feed.author.name }] }),
    items: items.map((item): JsonFeedItem => {
      const out: JsonFeedItem = { id: item.id, title: item.title, url: item.url };
      if (item.contentHtml !== null) {
        out.content_html = item.contentHtml;
      } else {
        // 1.1 requires at least one of content_html / content_text.
        out.content_text = item.summary;
      }
      if (item.summary !== "") {
        out.summary = item.summary;
      }
      if (item.published !== null) {
        out.date_published = item.published;
      }
      if (item.updated !== null && item.updated !== item.published) {
        out.date_modified = item.updated;
      }
      if (item.authorName !== null) {
        out.authors = [{ name: item.authorName }];
      }
      return out;
    }),
  };
  // `undefined` values are dropped by JSON.stringify, which is what keeps optional keys absent
  // Rather than null — a null `language` would claim the feed has no language.
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function jsonFeedUrl(siteUrl: string, output: string, archiveIndex?: number): string {
  return new URL(feedPath(output, "json", archiveIndex), siteUrl).href;
}
