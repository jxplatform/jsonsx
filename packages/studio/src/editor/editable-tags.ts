/**
 * Which tags can hold a text caret.
 *
 * The canvas carries a document-wide caret, so this set decides where a click lands — a tag missing
 * from it reads to the author as "this text is not editable", because clicking simply does nothing.
 * It used to be a hand-maintained list of thirteen tag names, which meant every new text-bearing
 * element had to be remembered here, and the list could disagree with what the document's own
 * vocabulary said.
 *
 * It is now DERIVED, from two sources resolved per tag:
 *
 * 1. **The format class**, when the document has one (`$studio.elements`, via
 *    {@link file://../format/constraints.ts}'s `formatEditableVerdicts`). Authoritative for the
 *    tags it declares — and able to say NO, which is why this is a per-tag lookup and not a union.
 * 2. **The studio's own element metadata** (`elements-meta.json`) for everything else: HTML that
 *    reaches the canvas through a directive, and native `.json` documents, which have no format
 *    class at all.
 *
 * The metadata rule is the same in both: a tag holds a caret when it accepts inline children.
 * Containers declare `"$inlineChildren": []` and are excluded by it without needing to be named.
 */

import elementsMeta from "../../data/elements-meta.json";

interface ElementDef {
  $inlineChildren?: string[];
}

/**
 * Tags the studio's own metadata says accept inline children.
 *
 * `pre` is excluded despite qualifying: its content is preformatted code, where whitespace is
 * significant and the inline-markup path does not apply. Markdown's format class independently
 * agrees (`"pre": { "only": ["code"] }`).
 */
const EXCLUDED = new Set(["pre"]);

export const BUILTIN_EDITABLE_TAGS: ReadonlySet<string> = new Set(
  Object.entries(elementsMeta.$defs as Record<string, ElementDef>)
    .filter(([tag, def]) => !EXCLUDED.has(tag) && (def.$inlineChildren?.length ?? 0) > 0)
    .map(([tag]) => tag),
);

/**
 * The format's per-tag overrides, or null when the document has no format class (a native `.json`
 * document) — in which case the built-in metadata answers on its own.
 */
export type EditableVerdicts = Readonly<Record<string, boolean>> | null;

/** Whether `tag` can hold a caret, given the live document's format overrides. */
export function isEditableTag(tag: string, verdicts: EditableVerdicts): boolean {
  const declared = verdicts?.[tag.toLowerCase()];
  return declared ?? BUILTIN_EDITABLE_TAGS.has(tag.toLowerCase());
}
