/**
 * Constraints — generic interpreter for a format class's `$studio.elements` metadata.
 *
 * Element allowlists and nesting rules are declared by the format (.class.json), not the studio;
 * this module turns that declaration into the validation helpers the editing surfaces use. Replaces
 * the hard-coded markdown allowlist.
 */

import type { StudioFormatHints } from "./format-host";

type ElementsHints = NonNullable<StudioFormatHints["elements"]>;

export interface NestingValidator {
  blockTags: ReadonlySet<string>;
  inlineTags: ReadonlySet<string>;
  allTags: ReadonlySet<string>;
  isVoid: (tag: string) => boolean;
  isTextOnly: (tag: string) => boolean;
  /** Whether childTag may appear inside parentTag ("_root" for the document root). */
  isValidChild: (parentTag: string, childTag: string) => boolean;
}

/** Build a nesting validator from a format's `$studio.elements` declaration. */
export function createNestingValidator(elements?: ElementsHints): NestingValidator {
  const blockTags = new Set(elements?.block);
  const inlineTags = new Set(elements?.inline);
  const allTags = new Set([...blockTags, ...inlineTags]);
  const voidTags = new Set(elements?.void);
  const textOnly = new Set(elements?.textOnly);
  const nesting = elements?.nesting ?? {};

  return {
    allTags,
    blockTags,
    inlineTags,
    isTextOnly: (tag) => textOnly.has(tag),
    isValidChild(parentTag, childTag) {
      const rule = nesting[parentTag];
      if (!rule) {
        return true;
      } // Unknown parents (directive components) allow anything

      if (rule.only) {
        return rule.only.includes(childTag);
      }

      const isBlock = blockTags.has(childTag);
      const isInline = inlineTags.has(childTag);
      const isDirective = !allTags.has(childTag);

      if (isBlock && rule.block) {
        return true;
      }
      if (isInline && rule.inline) {
        return true;
      }
      if (isDirective && rule.directive) {
        return true;
      }

      return false;
    },
    isVoid: (tag) => voidTags.has(tag),
  };
}

/**
 * The format's verdict on which of ITS tags can hold a text caret, as a plain `tag → boolean` map.
 *
 * A caret belongs in a tag that accepts inline children. The format's `nesting` declaration already
 * says exactly that, so nothing needs re-deriving from tag names:
 *
 * - `nesting[tag].inline === true` — the tag holds text. Headings, paragraphs, list items, cells.
 * - `nesting[tag]` present without it — a container. Markdown's `blockquote` is `inline: false`
 *   because it holds paragraphs, so the caret belongs in the `<p>` inside it, not the quote; `ul`,
 *   `table` and `pre` use `only: [...]` and hold no text at all.
 * - The tag is in the format's `inline` list — it is markup WITHIN a block, not a block. Without
 *   this, clicking a link would make the link itself the active block, and typing would commit to
 *   the anchor's path rather than the paragraph's.
 *
 * Only tags the format actually mentions appear here. A tag it says nothing about — HTML that
 * reaches the canvas through a directive — is left to the studio's own element metadata, so this
 * map is a set of OVERRIDES rather than a complete answer.
 *
 * Returned as a plain object because it crosses to the canvas frame with the render message.
 */
export function formatEditableVerdicts(elements?: ElementsHints): Record<string, boolean> {
  const verdicts: Record<string, boolean> = {};
  for (const [tag, rule] of Object.entries(elements?.nesting ?? {})) {
    // "_root" is the document itself, not an element.
    if (tag !== "_root") {
      verdicts[tag] = rule?.inline === true;
    }
  }
  for (const tag of elements?.inline ?? []) {
    verdicts[tag] = false;
  }
  return verdicts;
}
