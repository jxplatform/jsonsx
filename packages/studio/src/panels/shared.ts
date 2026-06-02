/// <reference lib="dom" />
/**
 * Shared panel utilities — portable helpers extracted from studio.js. These functions depend only
 * on store.js / state.js exports (no circular deps).
 */

import type { JxMutableNode } from "@jxsuite/schema/types";

/**
 * Convert a $media key like "--tablet" to a friendly display name "Tablet". "--" returns "Base".
 *
 * @param {string} name
 */
export function mediaDisplayName(name: string) {
  if (name === "--") return "Base";
  return (
    name
      .replace(/^--/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase()) || name
  );
}

export const unsafeTags = new Set(["script", "style", "link", "iframe", "object", "embed"]);

/**
 * Generate a sensible default Jx node for a given tag name.
 *
 * @param {string} tag
 */
export function defaultDef(tag: string) {
  const def: JxMutableNode = { tagName: tag };
  if (/^h[1-6]$/.test(tag)) def.textContent = "Heading";
  else if (tag === "p") def.textContent = "Paragraph text";
  else if (
    tag === "span" ||
    tag === "strong" ||
    tag === "em" ||
    tag === "small" ||
    tag === "mark" ||
    tag === "code" ||
    tag === "abbr" ||
    tag === "q" ||
    tag === "sub" ||
    tag === "sup" ||
    tag === "time"
  )
    def.textContent = "Text";
  else if (tag === "a") {
    def.textContent = "Link";
    def.attributes = { href: "#" };
  } else if (tag === "button") def.textContent = "Button";
  else if (tag === "label") def.textContent = "Label";
  else if (tag === "legend") def.textContent = "Legend";
  else if (tag === "caption") def.textContent = "Caption";
  else if (tag === "summary") def.textContent = "Summary";
  else if (
    tag === "li" ||
    tag === "dt" ||
    tag === "dd" ||
    tag === "th" ||
    tag === "td" ||
    tag === "option"
  )
    def.textContent = "Item";
  else if (tag === "blockquote") def.textContent = "Quote";
  else if (tag === "pre") def.textContent = "Preformatted text";
  else if (tag === "input") def.attributes = { type: "text", placeholder: "Enter text..." };
  else if (tag === "img") def.attributes = { src: "", alt: "Image" };
  else if (tag === "iframe") def.attributes = { src: "" };
  else if (tag === "select") def.children = [{ tagName: "option", textContent: "Option 1" }];
  else if (tag === "ul" || tag === "ol") def.children = [{ tagName: "li", textContent: "Item" }];
  else if (tag === "dl")
    def.children = [
      { tagName: "dt", textContent: "Term" },
      { tagName: "dd", textContent: "Definition" },
    ];
  else if (tag === "table")
    def.children = [
      {
        tagName: "thead",
        children: [{ tagName: "tr", children: [{ tagName: "th", textContent: "Header" }] }],
      },
      {
        tagName: "tbody",
        children: [{ tagName: "tr", children: [{ tagName: "td", textContent: "Cell" }] }],
      },
    ];
  else if (tag === "details")
    def.children = [
      { tagName: "summary", textContent: "Summary" },
      { tagName: "p", textContent: "Detail content" },
    ];
  return def;
}
