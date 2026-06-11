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
