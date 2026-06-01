/**
 * Md-allowlist.js — Markdown element allowlist and nesting constraints
 *
 * Defines which HTML elements are "native markdown" — they round-trip to pure markdown syntax.
 * Everything else is a Jx component directive.
 */

/** Block-level elements that map directly to markdown syntax */
export const MD_BLOCK = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

/** Inline elements that map directly to markdown syntax */
export const MD_INLINE = new Set(["em", "strong", "del", "code", "a", "img", "br"]);

/** All markdown-native elements */
export const MD_ALL = new Set([...MD_BLOCK, ...MD_INLINE]);

/** Elements that cannot contain children */
export const MD_VOID = new Set(["hr", "br", "img"]);

/** Elements that contain only text, not child elements */
export const MD_TEXT_ONLY = new Set(["code"]);

/**
 * Nesting constraints: which child elements are allowed inside each parent. null = any block/inline
 * allowed (used for content root and directive components).
 *
 * @type {Record<
 *   string,
 *   { block: boolean; inline: boolean; directive: boolean; only: Set<string> | null }
 * >}
 */
export const MD_NESTING: Record<
  string,
  { block: boolean; inline: boolean; directive: boolean; only: Set<string> | null }
> = {
  _root: { block: true, inline: false, directive: true, only: null },
  h1: { block: false, inline: true, directive: false, only: null },
  h2: { block: false, inline: true, directive: false, only: null },
  h3: { block: false, inline: true, directive: false, only: null },
  h4: { block: false, inline: true, directive: false, only: null },
  h5: { block: false, inline: true, directive: false, only: null },
  h6: { block: false, inline: true, directive: false, only: null },
  p: { block: false, inline: true, directive: true, only: null },
  blockquote: { block: true, inline: false, directive: true, only: null },
  ul: { block: false, inline: false, directive: false, only: new Set(["li"]) },
  ol: { block: false, inline: false, directive: false, only: new Set(["li"]) },
  li: { block: true, inline: true, directive: true, only: null },
  pre: { block: false, inline: false, directive: false, only: new Set(["code"]) },
  table: { block: false, inline: false, directive: false, only: new Set(["thead", "tbody"]) },
  thead: { block: false, inline: false, directive: false, only: new Set(["tr"]) },
  tbody: { block: false, inline: false, directive: false, only: new Set(["tr"]) },
  tr: { block: false, inline: false, directive: false, only: new Set(["th", "td"]) },
  th: { block: false, inline: true, directive: false, only: null },
  td: { block: false, inline: true, directive: false, only: null },
  em: { block: false, inline: true, directive: false, only: null },
  strong: { block: false, inline: true, directive: false, only: null },
  del: { block: false, inline: true, directive: false, only: null },
  a: { block: false, inline: true, directive: false, only: null },
};

/**
 * Check whether a tag is allowed as a child of the given parent tag in content mode.
 *
 * @param {string} parentTag - Parent element tag (or '_root' for content root)
 * @param {string} childTag - Proposed child element tag
 * @returns {boolean}
 */
export function isValidChild(parentTag: string, childTag: string) {
  const rule = MD_NESTING[parentTag];
  if (!rule) return true; // directive components allow anything

  // If there's a strict allowlist, check it
  if (rule.only) return rule.only.has(childTag);

  const isBlock = MD_BLOCK.has(childTag);
  const isInline = MD_INLINE.has(childTag);
  const isDirective = !MD_ALL.has(childTag);

  if (isBlock && rule.block) return true;
  if (isInline && rule.inline) return true;
  if (isDirective && rule.directive) return true;

  return false;
}
