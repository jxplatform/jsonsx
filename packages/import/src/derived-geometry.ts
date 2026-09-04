/**
 * Drop the `width` and `height` a browser MEASURED, keeping the ones a site actually authored.
 *
 * `getComputedStyle` returns used values, so `width` comes back as the pixels an element happens to
 * occupy rather than the `100%` or `auto` that produced them. Written into a document as an
 * unconditional style, that pins the layout: a full-width section captured at a 1440px viewport
 * becomes `width: 1440px` and never fills anything else again, which is visible the moment a canvas
 * is dragged wider than the width the import was taken at. On the reference corpus this was 814
 * elements pinned at 1000px or more, and `width` and `height` were the two most common declarations
 * in the entire project.
 *
 * `media-extract.ts` already removes these from BREAKPOINT deltas by sampling each band twice and
 * keeping only what both samples agree on. That technique cannot rescue the base, for a reason
 * worth writing down: a second sample must stay inside its own media band or it measures different
 * rules, and the base band is bounded below by the site's widest `min-width` breakpoint. A
 * container with `max-width: 1390px` measures 1390 at every width in that band, so it agrees with
 * itself and survives — while being exactly the fluid element the reader will notice.
 *
 * So the base needs a different question, and the useful one is structural rather than numerical:
 * **would this element have got that width on its own?** A block-level box in normal flow fills its
 * containing block by definition, and a `max-width` or `flex-basis` that narrows it is captured
 * separately and survives — so its measured `width` states a fact the layout already implies, and
 * removing it restores the fluidity without losing the constraint. A replaced element, an
 * out-of-flow box and a shrink-to-fit inline box are all sized by something the layout does NOT
 * imply, so their measurements are kept.
 */

import type { JxElement } from "@jxsuite/schema/types";

/** Elements sized by their own content or attributes rather than by their container. */
const REPLACED = new Set([
  "img",
  "svg",
  "video",
  "canvas",
  "iframe",
  "object",
  "embed",
  "input",
  "select",
  "textarea",
  "progress",
  "meter",
]);

/** A box taken out of the flow is positioned deliberately, so its measurements may be intentional. */
const OUT_OF_FLOW = new Set(["absolute", "fixed", "sticky"]);

/** A bare pixel length, which is the only shape a measurement takes. */
const PIXEL_LENGTH = /^-?[\d.]+px$/;

function isMeasured(value: unknown): boolean {
  return typeof value === "string" && PIXEL_LENGTH.test(value);
}

/**
 * Whether this node holds anything that gives it a height of its own.
 *
 * The distinction matters only for `height`. A box with content is as tall as that content, and
 * pinning it breaks the moment text reflows at a narrower width — the single most damaging way a
 * clone can fail. An EMPTY box is different: a spacer's entire purpose is its height, and there is
 * nothing else in the document that would reproduce it.
 */
function hasContent(node: JxElement): boolean {
  if (typeof node.textContent === "string" && node.textContent.trim().length > 0) {
    return true;
  }
  const children = Array.isArray(node.children) ? node.children : [];
  return children.some((child) =>
    typeof child === "string" ? child.trim().length > 0 : child !== undefined,
  );
}

/**
 * Remove measured geometry from a style object, in place.
 *
 * @param {JxElement} node - The element the style belongs to; its tag and content decide the answer
 * @param {Record<string, unknown>} style - The style object to filter, mutated
 * @param {Record<string, unknown>} [context] - Where `position` and `display` are read from, when
 *   they are not in `style` itself. A breakpoint delta carries only what CHANGED, so it usually
 *   states neither, and judging it on its own would strip an absolutely-positioned box's width on
 *   the grounds that it looked like an in-flow one.
 * @returns {number} How many declarations were removed
 */
export function dropDerivedGeometry(
  node: JxElement,
  style: Record<string, unknown>,
  context: Record<string, unknown> = style,
): number {
  const tag = String(node.tagName ?? "").toLowerCase();
  if (REPLACED.has(tag)) {
    return 0;
  }
  const position = style["position"] ?? context["position"];
  if (OUT_OF_FLOW.has(String(position ?? ""))) {
    return 0;
  }
  /* A shrink-to-fit box is sized by its content in the inline direction, so its width is not
     implied by its container the way a block-level box's is. */
  const display = style["display"] ?? context["display"];
  if (String(display ?? "").startsWith("inline")) {
    return 0;
  }

  let dropped = 0;
  if (isMeasured(style["width"])) {
    delete style["width"];
    dropped += 1;
  }
  if (isMeasured(style["height"]) && hasContent(node)) {
    delete style["height"];
    dropped += 1;
  }
  return dropped;
}
