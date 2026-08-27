/**
 * Strip the source site's CSS classes out of an imported tree.
 *
 * The importer never resolves a class to a style. Every visual fact it emits comes from
 * `getComputedStyle` (`style-capture.ts` → `style-diff.ts` → `apply-styles.ts`), and the only CSS
 * it writes is `public/assets/fonts.css`, built from `@font-face` rules alone — the original
 * stylesheets are collected for their fonts and then discarded. So an imported `class="hero
 * grid-cols-3 lg:pt-12"` names rules that do not exist in the emitted project: it is dead weight
 * that survives into every page, layout and component a reader then has to edit around.
 *
 * It is worse than inert in one place. `componentize.ts` treats every attribute as a prop
 * candidate, so a class that happens to differ between two instances of the same block becomes a
 * `${state.class}` prop with a name nobody chose. That is handled at the source there; this module
 * is what guarantees nothing reaches disk regardless.
 *
 * **This is not a claim that Jx is classless.** `className` is a first-class schema property
 * (`specs/spec.md` §8.1) and the compiler emits generated classes for nested style rules (§9.2);
 * neither changes. What is removed here is one specific thing: class names imported from a site
 * whose stylesheets were not imported with them.
 *
 * `id`, `role` and `aria-*` are deliberately left alone — anchors and accessibility survive the
 * round trip, and unlike a class they mean the same thing without the original CSS.
 *
 * @docs studio/projects/create
 */

import type { JxElement } from "@jxsuite/schema/types";

/** The two spellings a class can arrive in — `attributes.class` from HTML, `className` from Jx. */
const CLASS_KEYS = ["class", "className"] as const;

/**
 * Remove class names from `node` and every descendant, in place.
 *
 * @param {JxElement | string} node - A tree node; strings (text) pass through untouched.
 * @returns {number} How many class names were removed, for the progress line.
 */
export function stripClasses(node: JxElement | string): number {
  if (typeof node !== "object" || node === null) {
    return 0;
  }

  let removed = 0;

  if ("className" in node && node.className !== undefined) {
    delete node.className;
    removed += 1;
  }

  const { attributes } = node;
  if (attributes && typeof attributes === "object") {
    for (const key of CLASS_KEYS) {
      if (key in attributes) {
        delete (attributes as Record<string, unknown>)[key];
        removed += 1;
      }
    }
    /* An `attributes` map emptied by the strip is deleted rather than left as `{}`: the emitted JSON
       is read by a person, and a bare `"attributes": {}` on every node is the same noise the classes
       were. `htmlToJx` never writes an empty one either, so this restores its own invariant. */
    if (Object.keys(attributes).length === 0) {
      delete node.attributes;
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      removed += stripClasses(child as JxElement | string);
    }
  }

  return removed;
}
