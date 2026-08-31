/**
 * The nested selectors the Style tab offers for a given element.
 *
 * `COMMON_SELECTORS` is the global base and stays exactly that: eleven states every element can be
 * in. What it could not express is a state that only exists for SOME elements — `:popover-open` on
 * a `<p>` is a rule that can never match, and offering it there teaches the menu to be ignored.
 *
 * A separate module from `store.ts` because `store.ts` imports the world and this has to be
 * testable without a DOM. The additions are deliberately few: each one is a state the platform
 * gives that element and nothing else, so the menu stays a map of where to look rather than a
 * catalogue of CSS.
 *
 * @docs studio/design/states-and-selectors
 */

import { COMMON_SELECTORS } from "../store";
import { displayTagName } from "@jxsuite/schema/guards";
import { isPopover } from "@jxsuite/schema/overlays";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** Form controls that carry the validity and checked states. */
const FIELD_TAGS = new Set(["input", "select", "textarea"]);

/**
 * The states an element can be in beyond the common set.
 *
 * `::backdrop` is offered on a popover even though the canvas does not RENDER it (there is no
 * backdrop pseudo-element outside the top layer, and Preview is where it appears). Offering it is
 * still right: it is a real part of the shipped page, and the alternative — no way to author it
 * except by typing it into the custom-selector dialog — is worse than a state you check in
 * Preview.
 */
function extraSelectorsFor(node: JxMutableNode): string[] {
  const tag = displayTagName(node.tagName).toLowerCase();
  const out: string[] = [];
  if (isPopover(node)) {
    out.push(":popover-open", "::backdrop", ":popover-open::backdrop");
  }
  if (tag === "dialog") {
    out.push("[open]", ":modal", "::backdrop");
  }
  if (tag === "details") {
    out.push("[open]");
  }
  if (FIELD_TAGS.has(tag)) {
    out.push(":checked", ":invalid", ":required", ":user-invalid");
  }
  if (tag === "a") {
    out.push(":visited", ":target");
  }
  return out;
}

/**
 * Every selector the menu should offer for `node`, in a stable order and without duplicates.
 *
 * The common set first, so the menu does not reorder itself as the selection moves; the
 * element-specific ones after. Callers union this with what the element already DECLARES and with
 * the active selector, so nothing an author has written can drop out of the menu.
 *
 * @param node The selected node, or undefined when there is no selection.
 * @returns The offerable selectors.
 */
export function selectorsForNode(node: JxMutableNode | null | undefined): string[] {
  if (!node || typeof node !== "object") {
    return [...COMMON_SELECTORS];
  }
  return [...new Set([...COMMON_SELECTORS, ...extraSelectorsFor(node)])];
}
