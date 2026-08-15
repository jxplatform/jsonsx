/**
 * Atom 1.0 (RFC 4287), with RFC 5005 archived-feed links.
 *
 * Atom rather than RSS 2.0. RSS has no standards body, its date format is RFC 822, and its `<guid>`
 * semantics were never pinned down; Atom is an IETF standard with required identity and timestamps,
 * and every reader handles it. The omission is a decision, not an oversight.
 */

import { escapeXml, feedPath } from "./shared.ts";
import type { FeedItem, NormalizedFeed } from "./shared.ts";

const ATOM_NS = "http://www.w3.org/2005/Atom";
/** RFC 5005 §4 — the namespace for `<fh:complete/>`. */
const HISTORY_NS = "http://purl.org/syndication/history/1.0";

export interface AtomPage {
  /** Absolute site URL, used to build `<id>` values. */
  siteUrl: string;
  feed: NormalizedFeed;
  items: readonly FeedItem[];
  /** Absolute URL of THIS document. */
  selfUrl: string;
  /** The page the site's readers subscribe to. Absent on the subscription document itself. */
  currentUrl?: string;
  prevArchiveUrl?: string;
  nextArchiveUrl?: string;
  /** RFC 5005 §4: this document holds the feed's entire history. */
  complete?: boolean;
  /** Feed-level timestamp — the newest item, never the build time. */
  updated: string | null;
}

function tag(name: string, value: string | null | undefined, indent = "  "): string {
  return value === null || value === undefined || value === ""
    ? ""
    : `${indent}<${name}>${escapeXml(value)}</${name}>\n`;
}

function link(rel: string, href: string, type?: string): string {
  const t = type === undefined ? "" : ` type="${type}"`;
  return `  <link rel="${rel}" href="${escapeXml(href)}"${t}/>\n`;
}

function renderEntry(item: FeedItem): string {
  const inner = "    ";
  const author =
    item.authorName === null
      ? ""
      : `${inner}<author>\n${inner}  <name>${escapeXml(item.authorName)}</name>\n${inner}</author>\n`;
  return [
    "  <entry>\n",
    tag("id", item.id, inner),
    tag("title", item.title, inner),
    `${inner}<link rel="alternate" href="${escapeXml(item.url)}"/>\n`,
    tag("updated", item.updated ?? item.published, inner),
    tag("published", item.published, inner),
    author,
    tag("summary", item.summary, inner),
    item.contentHtml === null
      ? ""
      : `${inner}<content type="html">${escapeXml(item.contentHtml)}</content>\n`,
    "  </entry>\n",
  ].join("");
}

export function renderAtom(page: AtomPage): string {
  const { feed, items, siteUrl } = page;
  const ns = page.complete ? ` xmlns:fh="${HISTORY_NS}"` : "";
  const head = [
    '<?xml version="1.0" encoding="utf-8"?>\n',
    `<feed xmlns="${ATOM_NS}"${ns}>\n`,
    tag("id", page.selfUrl),
    tag("title", feed.title === "" ? "Feed" : feed.title),
    tag("subtitle", feed.description),
    /*
     * RFC 4287 requires `<updated>`. It is the newest ITEM, not the build time: a feed whose
     * timestamp moves on every deploy re-notifies every subscriber for no reason.
     */
    tag("updated", page.updated ?? "1970-01-01T00:00:00Z"),
    link("self", page.selfUrl, "application/atom+xml"),
    link("alternate", new URL(feed.basePath, siteUrl).href, "text/html"),
    page.currentUrl === undefined ? "" : link("current", page.currentUrl, "application/atom+xml"),
    page.prevArchiveUrl === undefined
      ? ""
      : link("prev-archive", page.prevArchiveUrl, "application/atom+xml"),
    page.nextArchiveUrl === undefined
      ? ""
      : link("next-archive", page.nextArchiveUrl, "application/atom+xml"),
    page.complete === true ? "  <fh:complete/>\n" : "",
    feed.author?.name === undefined
      ? ""
      : `  <author>\n    <name>${escapeXml(feed.author.name)}</name>\n${
          feed.author.uri === undefined ? "" : `    <uri>${escapeXml(feed.author.uri)}</uri>\n`
        }${
          feed.author.email === undefined
            ? ""
            : `    <email>${escapeXml(feed.author.email)}</email>\n`
        }  </author>\n`,
  ];
  return `${head.join("")}${items.map((i) => renderEntry(i)).join("")}</feed>\n`;
}

/** Absolute URL of an Atom document within this feed. */
export function atomUrl(siteUrl: string, output: string, archiveIndex?: number): string {
  return new URL(feedPath(output, "xml", archiveIndex), siteUrl).href;
}
