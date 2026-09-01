/// <reference lib="dom" />
/**
 * Document positions — the caret's model coordinates.
 *
 * A DOM caret (`{ node, offset }`) is destroyed by any re-render of its block, so it cannot survive
 * a surgical patch, a subtree render, or a cross-block edit. A {@link DocPos} is the same position
 * expressed against the DOCUMENT: the block's `data-jx-path` plus a character offset into that
 * block's rendered text. It survives anything that leaves the block's path resolvable, which is
 * what lets the caret stay put while the patcher rewrites the DOM underneath it.
 *
 * The offset is deliberately measured in CHARACTERS OF RENDERED TEXT, not DOM child indices, so it
 * is agnostic to inline markup: `<p>a<strong>bc</strong>d</p>` has length 4, and offset 3 is
 * between "c" and "d" no matter how the bold run is nested (or whether a commit re-nested it).
 *
 * Everything here is pure DOM traversal with NO layout reads, so it is fully exercisable under
 * happy-dom — unlike the caret-from-point and line-geometry paths, which are Chromium-only.
 *
 * @docs studio/editing/writing
 */

import { jxPathSelector, parseJxPath, serializeJxPath } from "./path-mapping";
import type { JxPath } from "../state";

/** A caret/selection endpoint in document coordinates: a block path + a character offset into it. */
export interface DocPos {
  path: JxPath;
  offset: number;
}

/** A selection in document coordinates. Collapsed when both ends are equal. */
export interface DocRange {
  anchor: DocPos;
  head: DocPos;
}

/** Whether an element is a block the caret may live inside. Injected so the editable set is policy. */
export type EditablePredicate = (el: HTMLElement) => boolean;

/**
 * Whether an element ends the walk up from a caret: a component instance is an atomic island whose
 * internals belong to another document.
 *
 * Without this barrier a caret inside a component would keep walking and find an ancestor PAGE
 * block, so typing would rewrite the whole instance's `children` — silently replacing the component
 * with the text you typed. Component instances render `contenteditable="false"` (see
 * `makeStamper`); the tag-name test is the belt-and-braces twin for trees that were never stamped.
 *
 * A component definition opened as its own document is excluded: there its subtree IS the document.
 */
function isIslandBoundary(el: HTMLElement): boolean {
  if (el.dataset.jxDefinitionRoot !== undefined) {
    return false;
  }
  return el.getAttribute("contenteditable") === "false" || el.tagName.includes("-");
}

/**
 * The nearest ancestor-or-self of `node` that is an editable block carrying a `data-jx-path`.
 *
 * Mirrors the walk-up in {@link file://./iframe-inline-edit.ts}'s `findEditableTarget`, but starts
 * from a DOM node (a Selection endpoint) rather than an event target, and returns the parsed path.
 * The walk stops at a component island — see {@link isIslandBoundary}.
 */
export function activeBlockAt(
  node: Node | null,
  isEditable: EditablePredicate,
): { el: HTMLElement; path: JxPath } | null {
  let el = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el) {
    if (el instanceof HTMLElement) {
      if (el.dataset.jxPath && isEditable(el)) {
        return { el, path: parseJxPath(el.dataset.jxPath) };
      }
      if (isIslandBoundary(el)) {
        return null;
      }
    }
    el = el.parentElement;
  }
  return null;
}

/** Locate the rendered element for a document path via its stamped `data-jx-path`. */
export function elementForPath(container: HTMLElement, path: JxPath): HTMLElement | null {
  // The escaping lives in `jxPathSelector`, which the popover work extracted for its own lookup.
  // This function had the only other copy of it, and two spellings of one escaping rule is how the
  // Two come to disagree about a path containing a quote.
  const el = container.querySelector(jxPathSelector(serializeJxPath(path)));
  return el instanceof HTMLElement ? el : null;
}

/** The block's rendered text length — the maximum valid offset within it. */
export function blockTextLength(block: HTMLElement): number {
  return block.textContent?.length ?? 0;
}

/**
 * The character offset of a DOM position within `block`.
 *
 * Measured with a Range rather than a hand-rolled TreeWalker so that element-anchored carets (the
 * caret sitting "at child index N" rather than inside a text node — what the browser produces next
 * to a `<br>` or an atomic island) resolve by the same rule as text-anchored ones. Returns null
 * when the position is not inside the block.
 */
export function offsetOf(block: HTMLElement, node: Node, offset: number): number | null {
  if (!block.contains(node)) {
    return null;
  }
  const range = block.ownerDocument.createRange();
  range.setStart(block, 0);
  try {
    range.setEnd(node, offset);
  } catch {
    // An offset past the node's length (a stale position against a re-rendered node).
    return null;
  }
  return range.toString().length;
}

/**
 * The DOM position for a character offset within `block`, clamped into range.
 *
 * The inverse of {@link offsetOf} up to one well-known ambiguity: a `<br>` contributes no
 * characters, so the position immediately before and immediately after a soft line break share an
 * offset and resolve to the earlier (end-of-previous-line) DOM position. That is the same ambiguity
 * every offset-based editor carries at a line break, and it is invisible for the paths that use
 * this (caret restore after a patch, and block-boundary edits, which clamp to 0 / length anyway).
 */
export function domPositionAt(block: HTMLElement, offset: number): { node: Node; offset: number } {
  const target = Math.max(0, Math.min(offset, blockTextLength(block)));
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  let current = walker.nextNode() as Text | null;
  while (current) {
    const len = current.length;
    if (seen + len >= target) {
      return { node: current, offset: target - seen };
    }
    seen += len;
    last = current;
    current = walker.nextNode() as Text | null;
  }
  // No text node reaches the target: either the block has no text at all (caret goes to the element
  // Itself) or the walk ended early on a whitespace-collapsed tail (caret goes to the last text end).
  return last ? { node: last, offset: last.length } : { node: block, offset: 0 };
}

/**
 * Convert a DOM position to document coordinates. Returns null when the position is not inside any
 * editable block (canvas chrome, a `contenteditable="false"` island, layout-only nodes).
 */
export function toDocPos(
  node: Node | null,
  offset: number,
  isEditable: EditablePredicate,
): DocPos | null {
  const block = activeBlockAt(node, isEditable);
  if (!block || !node) {
    return null;
  }
  const charOffset = offsetOf(block.el, node, offset);
  return charOffset === null ? null : { offset: charOffset, path: block.path };
}

/**
 * Resolve a document position back to a live DOM position. Returns null only when the path no
 * longer resolves to an element — a stale OFFSET is clamped rather than rejected, so a caret in a
 * block whose text shrank under a remote edit lands at the block's new end instead of being
 * dropped.
 */
export function toDomPosition(
  container: HTMLElement,
  pos: DocPos,
): { node: Node; offset: number } | null {
  const el = elementForPath(container, pos.path);
  return el ? domPositionAt(el, pos.offset) : null;
}

/** Whether a document position sits at the very start of its block. */
export function isAtBlockStart(pos: DocPos): boolean {
  return pos.offset <= 0;
}

/** Whether a document position sits at the very end of its block, given the block's live element. */
export function isAtBlockEnd(block: HTMLElement, pos: DocPos): boolean {
  return pos.offset >= blockTextLength(block);
}

/** Whether two document positions address the same block. */
export function samePath(a: DocPos, b: DocPos): boolean {
  return serializeJxPath(a.path) === serializeJxPath(b.path);
}

/**
 * Every block the caret can reach inside `container`, in DOCUMENT ORDER.
 *
 * Order comes from the rendered DOM rather than from the document tree because that is where it is
 * already correct: a list item, a table cell, a block inside a nested container, and a repeater's
 * rendered rows all fall into the right sequence with no traversal rules to get wrong. Blocks
 * inside a component island are excluded — {@link activeBlockAt} refuses to resolve out of one, so a
 * block that does not resolve to ITSELF is not reachable by the caret.
 */
export function blocksInOrder(
  container: HTMLElement,
  isEditable: EditablePredicate,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of container.querySelectorAll<HTMLElement>("[data-jx-path]")) {
    if (isEditable(el) && !sealedInIsland(el, container)) {
      out.push(el);
    }
  }
  return out;
}

/**
 * Whether any ancestor of `el` up to `container` is a component island.
 *
 * {@link activeBlockAt} cannot answer this for a block that is itself stamped — the walk returns
 * that block immediately and never reaches the barrier above it. Caret navigation has to look
 * upward explicitly, or arrowing through the document would step into a component's internals.
 */
function sealedInIsland(el: HTMLElement, container: HTMLElement): boolean {
  let cur = el.parentElement;
  while (cur && cur !== container) {
    if (isIslandBoundary(cur)) {
      return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

/**
 * The block immediately before (-1) or after (+1) `path` in document order, or null at the ends of
 * the document.
 */
export function adjacentBlock(
  container: HTMLElement,
  path: JxPath,
  direction: -1 | 1,
  isEditable: EditablePredicate,
): { el: HTMLElement; path: JxPath } | null {
  const blocks = blocksInOrder(container, isEditable);
  const key = serializeJxPath(path);
  const index = blocks.findIndex((el) => el.dataset.jxPath === key);
  const neighbour = index === -1 ? undefined : blocks[index + direction];
  return neighbour
    ? { el: neighbour, path: parseJxPath(neighbour.dataset.jxPath as string) }
    : null;
}
