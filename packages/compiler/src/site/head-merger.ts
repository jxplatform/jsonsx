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
import type { HeadMergeContext } from "../types";

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
    { tagName: "meta", attributes: { charset: context.charset ?? "utf-8" } },
    {
      tagName: "meta",
      attributes: { name: "viewport", content: "width=device-width, initial-scale=1" },
    },
  ];

  // Merge layers: site → layout → page (later wins)
  const merged: Map<string, JxHeadEntry> = new Map();

  for (const entry of [...defaults, ...siteHead, ...layoutHead, ...pageHead]) {
    const key = headEntryKey(entry);
    merged.set(key, entry);
  }

  // Insert <title> if present
  const title = context.title ?? context.siteName ?? "Jx Site";
  merged.set("title", { tagName: "title", children: [title] });

  // Add canonical URL if provided
  if (context.pageUrl && context.siteUrl) {
    const canonical = new URL(context.pageUrl, context.siteUrl).href;
    merged.set("link:canonical", {
      tagName: "link",
      attributes: { rel: "canonical", href: canonical },
    });
  }

  return Array.from(merged.values());
}

/**
 * Generate a deduplication key for a <head> element. Elements with the same key are considered
 * duplicates; the last one wins.
 *
 * @param {JxHeadEntry} entry
 * @returns {string}
 */
function headEntryKey(entry: JxHeadEntry) {
  if (!entry || typeof entry !== "object") return String(entry);

  const tag = entry.tagName ?? "unknown";
  const attrs = entry.attributes ?? {};

  // <title> — singleton
  if (tag === "title") return "title";

  // <meta charset> — singleton
  if (attrs.charset) return "meta:charset";

  // <meta name="...""> — keyed by name
  if (tag === "meta" && attrs.name) return `meta:${attrs.name}`;

  // <meta property="..."> — keyed by property (Open Graph)
  if (tag === "meta" && attrs.property) return `meta:${attrs.property}`;

  // <link rel="..." href="..."> — keyed by rel+href
  if (tag === "link" && attrs.rel) {
    return `link:${attrs.rel}:${attrs.href ?? ""}`;
  }

  // <script src="..."> — keyed by src
  if (tag === "script" && attrs.src) return `script:${attrs.src}`;

  // <style> — unique per content hash
  if (tag === "style") {
    const content = Array.isArray(entry.children)
      ? entry.children.join("")
      : (entry.textContent ?? "");
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
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
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
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";

  const tag = entry.tagName;
  const attrs = entry.attributes ?? {};
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => (v === true ? k : `${k}="${escapeAttr(v)}"`))
    .join(" ");

  const open = attrStr ? `<${tag} ${attrStr}>` : `<${tag}>`;

  // Void elements (no closing tag)
  const VOID = new Set(["meta", "link", "base", "br", "hr", "img", "input"]);
  if (VOID.has(tag)) return open;

  // Elements with content
  const content = Array.isArray(entry.children)
    ? entry.children.join("")
    : (entry.textContent ?? "");
  return `${open}${content}</${tag}>`;
}

/**
 * @param {unknown} val
 * @returns {string}
 */
function escapeAttr(val: unknown) {
  return String(val).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
