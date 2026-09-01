/**
 * Read the CSS the stylesheet engine adopted, the way the old assertions read a `<style>` tag.
 *
 * Roughly sixty style assertions used to say `elementStyleTags.get(el)!.textContent`. There is no
 * tag any more — rules go into the document's `adoptedStyleSheets` — so this is the one place that
 * knows how to get the text back, and migrating the assertions meant changing the accessor rather
 * than sixty expectations.
 *
 * `elementCSS` filters by the element's `data-jx` handle, which is what made the per-element tag
 * useful in the first place. It deliberately does NOT include the document-global declaration
 * at-rules (`@font-face`, `@position-try`) an element's style object can also produce: those are
 * hoisted and shared, so `documentStyleText()` is the right question to ask about them.
 */

import { documentStyleText } from "../src/runtime.ts";

/** Every rule the engine wrote into `doc`, one per line. */
export function adoptedCSS(doc: Document = document): string {
  return documentStyleText(doc);
}

/** The rules scoped to one element's `data-jx` handle, one per line. */
export function elementCSS(el: HTMLElement): string {
  const uid = el.dataset.jx;
  if (uid === undefined) {
    return "";
  }
  const handle = `[data-jx="${uid}"]`;
  return documentStyleText(el.ownerDocument)
    .split("\n")
    .filter((line) => line.includes(handle))
    .join("\n");
}

/**
 * Whether the engine holds any rules for this element.
 *
 * The replacement for `expect(elementStyleTags.get(el)).toBeUndefined()`, which used to mean "no
 * tag was emitted" and now means "no rule set is adopted".
 */
export function hasAdoptedRules(el: HTMLElement): boolean {
  return elementCSS(el) !== "";
}
