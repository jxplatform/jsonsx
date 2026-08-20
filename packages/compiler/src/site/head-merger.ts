/**
 * Head-merger.js — $head merge pipeline
 *
 * Merges <head> element arrays from three levels:
 *
 * 1. Site.json.$head — global (e.g., favicon, global stylesheet)
 * 2. Layout.$head — layout-level (e.g., shared nav scripts)
 * 3. Page.$head — page-specific (e.g., per-page meta tags)
 *
 * Per site-architecture spec §8:
 *
 * - Later levels override earlier levels for the same element
 * - Deduplication by tagName + key attribute (name, property, rel+href)
 * - Charset and viewport are auto-injected if missing
 */

import type { JxHeadEntry } from "@jxsuite/schema/types";
import type { HeadMergeContext } from "../types.ts";

/**
 * Merge $head arrays from site, layout, and page levels.
 *
 * @param {JxHeadEntry[]} [siteHead] - Site.json $head entries
 * @param {JxHeadEntry[]} [layoutHead] - Layout $head entries (may be empty)
 * @param {JxHeadEntry[]} [pageHead] - Page $head entries (may be empty)
 * @param {HeadMergeContext} [context] - { title, lang, charset, url, pageUrl }
 * @returns {JxHeadEntry[]} Merged, deduplicated $head array
 */
export function mergeHead(
  siteHead: JxHeadEntry[] = [],
  layoutHead: JxHeadEntry[] = [],
  pageHead: JxHeadEntry[] = [],
  context: HeadMergeContext = {},
) {
  // Start with auto-injected defaults
  const defaults: JxHeadEntry[] = [
    { attributes: { charset: context.charset ?? "utf8" }, tagName: "meta" },
    {
      attributes: {
        content: "width=device-width, initial-scale=1",
        name: "viewport",
      },
      tagName: "meta",
    },
  ];

  // Merge layers: site → layout → page (later wins)
  const merged = new Map<string, JxHeadEntry>();

  for (const entry of [...defaults, ...siteHead, ...layoutHead, ...pageHead]) {
    const key = headEntryKey(entry);
    merged.set(key, entry);
  }

  // Insert <title> if present
  const title = context.title ?? context.siteName ?? "Jx Site";
  merged.set("title", { children: [title], tagName: "title" });

  // Add canonical URL if provided
  if (context.pageUrl && context.siteUrl) {
    const canonical = new URL(context.pageUrl, context.siteUrl).href;
    /*
     * An author-supplied canonical wins, like every other auto-injected entry (§8.4). This used a
     * hand-written `link:canonical` key that `headEntryKey` never produces, so the author's entry
     * and this one landed under different keys and the page got BOTH — which is the one thing a
     * canonical link must not be.
     */
    const hasAuthored = [...merged.values()].some(
      (e) =>
        e && typeof e === "object" && e.tagName === "link" && e.attributes?.rel === "canonical",
    );
    if (!hasAuthored) {
      const entry: JxHeadEntry = {
        attributes: { href: canonical, rel: "canonical" },
        tagName: "link",
      };
      merged.set(headEntryKey(entry), entry);
    }
    // Auto OpenGraph identity (site-architecture §8.4) — author-supplied values win.
    if (!merged.has("meta:og:url")) {
      merged.set("meta:og:url", {
        attributes: { content: canonical, property: "og:url" },
        tagName: "meta",
      });
    }
  }
  if (context.siteName && !merged.has("meta:og:site_name")) {
    merged.set("meta:og:site_name", {
      attributes: { content: context.siteName, property: "og:site_name" },
      tagName: "meta",
    });
  }

  /*
   * Locale alternates (site-architecture.md §13.5). Keyed through `headEntryKey` like everything
   * else, which is what keeps a set of them from collapsing: they share `rel="alternate"` and
   * differ only in `hreflang`, and `x-default` conventionally shares its `href` with the default
   * locale's entry. Before the key accounted for the qualifying attribute this whole feature was
   * impossible — the set became one link.
   *
   * An author-supplied alternate for the same `hreflang` wins, like every other auto entry.
   */
  for (const alternate of context.alternates ?? []) {
    const entry: JxHeadEntry = {
      attributes: { href: alternate.href, hreflang: alternate.hreflang, rel: "alternate" },
      tagName: "link",
    };
    const key = headEntryKey(entry);
    if (!merged.has(key)) {
      merged.set(key, entry);
    }
  }

  return [...merged.values()];
}

/**
 * Generate a deduplication key for a <head> element. Elements with the same key are considered
 * duplicates; the last one wins.
 *
 * @param {JxHeadEntry} entry
 * @returns {string}
 */
function headEntryKey(entry: JxHeadEntry) {
  if (!entry || typeof entry !== "object") {
    return String(entry);
  }

  const tag = entry.tagName ?? "unknown";
  const attrs = entry.attributes ?? {};

  // <title> — singleton
  if (tag === "title") {
    return "title";
  }

  // <meta charset> — singleton
  if (attrs.charset) {
    return "meta:charset";
  }

  // <meta name="...""> — keyed by name
  if (tag === "meta" && attrs.name) {
    return `meta:${attrs.name}`;
  }

  // <meta property="..."> — keyed by property (Open Graph)
  if (tag === "meta" && attrs.property) {
    return `meta:${attrs.property}`;
  }

  /*
   * <link> — keyed by rel + href + the attribute that distinguishes two links sharing both.
   *
   * `rel` + `href` alone is not identity, and the cases where it fails are the ones a site actually
   * needs: `hreflang="x-default"` conventionally points at the SAME href as the default locale's
   * alternate, and an RSS and an Atom feed are both `rel="alternate"` differing only in `type`.
   * `icon` differs by `sizes` and `stylesheet` by `media` for the same reason.
   */
  if (tag === "link" && attrs.rel) {
    const qualifier = attrs.hreflang ?? attrs.type ?? attrs.media ?? attrs.sizes ?? "";
    return `link:${attrs.rel}:${attrs.href ?? ""}:${String(qualifier)}`;
  }

  // <script src="..."> — keyed by src
  if (tag === "script" && attrs.src) {
    return `script:${attrs.src}`;
  }

  // <style> — unique per content hash
  if (tag === "style") {
    const raw = Array.isArray(entry.children) ? entry.children.join("") : entry.textContent;
    const content = typeof raw === "object" && raw !== null ? JSON.stringify(raw) : (raw ?? "");
    return `style:${simpleHash(content)}`;
  }

  // Fallback — use full JSON serialization
  return `${tag}:${JSON.stringify(entry)}`;
}

/**
 * Simple string hash for deduplication (not cryptographic).
 *
 * @param {string} str
 * @returns {string}
 */
function simpleHash(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    // oxlint-disable-next-line no-bitwise -- classic 31x string hash; the shift is the algorithm
    hash = Math.trunc((hash << 5) - hash + (str.codePointAt(i) ?? 0));
  }
  return hash.toString(36);
}

/**
 * Render a merged $head array to HTML string for insertion into <head>.
 *
 * @param {JxHeadEntry[]} headEntries - Merged head entries
 * @returns {string} HTML string
 */
export function renderHead(headEntries: JxHeadEntry[]) {
  return headEntries.map((e: JxHeadEntry) => renderHeadEntry(e)).join("\n  ");
}

/**
 * Render a single $head entry to an HTML string.
 *
 * @param {JxHeadEntry} entry
 * @returns {string}
 */
function renderHeadEntry(entry: JxHeadEntry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (!entry || typeof entry !== "object") {
    return "";
  }

  const tag = entry.tagName;
  const attrs = entry.attributes ?? {};
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => (v === true ? k : `${k}="${escapeAttr(v)}"`))
    .join(" ");

  const open = attrStr ? `<${tag} ${attrStr}>` : `<${tag}>`;

  // Void elements (no closing tag)
  const VOID = new Set(["meta", "link", "base", "br", "hr", "img", "input"]);
  if (VOID.has(tag)) {
    return open;
  }

  /*
   * Elements with content. `textContent` may be an OBJECT: that is how a JSON-LD block is authored
   * (§8.5), and serializing it here is what the spec has always promised. Left as-is it reached the
   * page as the string "[object Object]".
   */
  const raw = Array.isArray(entry.children) ? entry.children.join("") : entry.textContent;
  const content =
    raw !== null && typeof raw === "object" ? JSON.stringify(raw, null, 2) : (raw ?? "");
  return `${open}${content}</${tag}>`;
}

/**
 * @param {unknown} val
 * @returns {string}
 */
function escapeAttr(val: unknown) {
  return String(val).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
