/** Google Fonts helpers — shared between head-panel (per-page) and head-editor (project-level). */

import type { JxHeadEntry } from "@jxsuite/schema/types";

export const GFONTS_CSS_PREFIX = "https://fonts.googleapis.com/css2?";
export const GFONTS_PRECONNECT_ORIGINS = [
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

/**
 * Check if a `$head` entry is a Google Fonts stylesheet link.
 *
 * @param {JxHeadEntry} entry
 * @returns {boolean}
 */
export function isGoogleFontEntry(entry: JxHeadEntry) {
  return (
    entry?.tagName === "link" &&
    entry?.attributes?.rel === "stylesheet" &&
    typeof entry?.attributes?.href === "string" &&
    (entry.attributes.href as string).startsWith(GFONTS_CSS_PREFIX)
  );
}

/**
 * Check if a `$head` entry is a Google Fonts preconnect link.
 *
 * @param {JxHeadEntry} entry
 * @returns {boolean}
 */
export function isGoogleFontPreconnect(entry: JxHeadEntry) {
  return (
    entry?.tagName === "link" &&
    entry?.attributes?.rel === "preconnect" &&
    GFONTS_PRECONNECT_ORIGINS.includes(entry?.attributes?.href as string)
  );
}

/**
 * Extract the font family name from a Google Fonts CSS URL.
 *
 * @param {string} href
 * @returns {string}
 */
export function extractFontFamily(href: string) {
  const match = href.match(/family=([^&:]+)/);
  if (!match) {
    return "";
  }
  return decodeURIComponent(match[1].replaceAll("+", " "));
}

/**
 * Build a Google Fonts CSS2 URL for a family name.
 *
 * @param {string} family
 * @returns {string}
 */
export function buildGoogleFontUrl(family: string) {
  return `${GFONTS_CSS_PREFIX}family=${encodeURIComponent(family).replaceAll("%20", "+")}&display=swap`;
}

/**
 * Ensure preconnect links exist in a `$head` array for Google Fonts.
 *
 * @param {JxHeadEntry[]} head
 */
export function ensureGoogleFontPreconnects(head: JxHeadEntry[]) {
  for (const origin of GFONTS_PRECONNECT_ORIGINS) {
    const exists = head.some(
      (e: JxHeadEntry) =>
        e?.tagName === "link" &&
        e?.attributes?.rel === "preconnect" &&
        e?.attributes?.href === origin,
    );
    if (!exists) {
      const attrs: Record<string, string | boolean> = {
        href: origin,
        rel: "preconnect",
      };
      if (origin === "https://fonts.gstatic.com") {
        attrs.crossorigin = "";
      }
      head.push({ attributes: attrs, tagName: "link" });
    }
  }
}

/**
 * Remove preconnect links if no Google Font stylesheets remain.
 *
 * @param {JxHeadEntry[]} head
 * @returns {JxHeadEntry[]}
 */
export function cleanupGoogleFontPreconnects(head: JxHeadEntry[]) {
  const hasFont = head.some((e: JxHeadEntry) => isGoogleFontEntry(e));
  if (!hasFont) {
    return head.filter((e: JxHeadEntry) => !isGoogleFontPreconnect(e));
  }
  return head;
}
