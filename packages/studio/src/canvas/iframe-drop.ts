/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * In-iframe drop math (Phase 4c). Runs INSIDE the canvas iframe, in the iframe's own realm/coords.
 *
 * Split for testability: - {@link resolveDropTarget} is the thin DOM adapter (point hit-test →
 * nearest `data-jx-path`); it is CDP-ONLY because happy-dom's `elementFromPoint` returns null (no
 * layout), so it carries no branching logic worth unit-proving against a fake. -
 * {@link computeDropInstruction} is PURE: it reads element rects through {@link rectOf} (stubbable)
 * and the iframe's shadow doc, and resolves the structural placement. It ports the legacy
 * `getCanvasDropResult`/`nearestChildEdge` math (canvas-dnd.ts) against IFRAME-realm geometry, and
 * reproduces the EXACT `[...parentPath, "children", index]` targetPath shape so the parent's
 * realm-agnostic `applyDropInstruction` resolves the same parent/index.
 *
 * The drop is computed FRESH in the iframe's `drop` handler from the live DOM — a `dragOver`
 * preview is display-only and never the source of truth (patch-mid-drag safety).
 */

import { parseJxPath } from "./path-mapping";
import { displayTagName } from "@jxsuite/schema/guards";
import { rectOf, elementAtPoint } from "../utils/geometry";
import { getNodeAtPath, isAncestor, pathsEqual } from "../state";
import type { DragSrcKind, DropPreview } from "./iframe-protocol";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../state";

/**
 * Void (self-closing) HTML tags that cannot accept children — a leaf for drop purposes. COPIED from
 * the store's `VOID_ELEMENTS` literal so this module stays dependency-light (the iframe bundle must
 * not pull in the store). Keep in sync with store.ts:VOID_ELEMENTS.
 */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Walk up from an element to the nearest ancestor carrying a `data-jx-path`. Refactored out of the
 * `nearestHit` walk (iframe-interaction.ts) to take an element directly so the hit-test adapter can
 * reuse it. Returns null when no addressable node is found.
 */
function nearestPathEl(start: Element | null): HTMLElement | null {
  let el = start instanceof Element ? (start as HTMLElement) : null;
  while (el) {
    if (el.dataset?.jxPath) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Point hit-test in iframe-viewport coords (`x`,`y`): the topmost element, then walk to the nearest
 * `[data-jx-path]` ancestor. CDP-ONLY — happy-dom's `elementFromPoint` returns null (no layout), so
 * this thin adapter is exercised under a real browser, not a unit test.
 */
export function resolveDropTarget(x: number, y: number, doc: Document): HTMLElement | null {
  const hit = elementAtPoint(x, y, doc);
  return nearestPathEl(hit);
}

/**
 * Compute the structural drop placement for a cursor over `targetEl`, PURE against iframe-realm
 * rects.
 *
 * `cursorY` is in iframe-viewport coords (same space as {@link rectOf}); `shadowDoc` is the
 * iframe's non-reactive shadow doc (path coordinate space); `src` is the realm-agnostic drag
 * source.
 *
 * Branching (ported from canvas-dnd.ts getCanvasDropResult/nearestChildEdge):
 *
 * - Root (path.length===0) with element children → nearest child edge (reorder-above/below that
 *   child).
 * - Leaf (void tag, or no element children) → relY<0.5 above (edge top) else below (edge bottom).
 * - Container → relY<0.25 above, >0.75 below, else make-child (edge inside). Returns null when the
 *   drop is disallowed (a tree-node onto its own ancestor or itself).
 */
export function computeDropInstruction(
  targetEl: HTMLElement,
  cursorY: number,
  shadowDoc: JxMutableNode,
  src: DragSrcKind,
): DropPreview | null {
  const serialized = targetEl.dataset?.jxPath;
  if (serialized == null) {
    return null;
  }
  const targetPath = parseJxPath(serialized) as JxPath;

  // Root: pick the nearest child edge among the element's element children.
  if (targetPath.length === 0) {
    const children = [...targetEl.children] as HTMLElement[];
    if (children.length === 0) {
      return canDrop(src, targetPath)
        ? {
            edge: "inside",
            instruction: "make-child",
            referenceRect: rectFor(targetEl),
            targetPath,
          }
        : null;
    }
    return nearestChildEdge(children, cursorY, targetPath, src);
  }

  if (!canDrop(src, targetPath)) {
    return null;
  }

  const node = getNodeAtPath(shadowDoc, targetPath) as JxMutableNode | undefined;
  const tag = (displayTagName(node?.tagName) || "div").toLowerCase();
  const hasElementChildren =
    Array.isArray(node?.children) &&
    node.children.some((c: unknown) => c != null && typeof c === "object");
  const isLeaf = VOID_TAGS.has(tag) || !hasElementChildren;

  const rect = rectFor(targetEl);
  const relY = rect.height === 0 ? 0 : (cursorY - rect.y) / rect.height;

  if (isLeaf) {
    return relY < 0.5
      ? { edge: "top", instruction: "reorder-above", referenceRect: rect, targetPath }
      : { edge: "bottom", instruction: "reorder-below", referenceRect: rect, targetPath };
  }
  if (relY < 0.25) {
    return { edge: "top", instruction: "reorder-above", referenceRect: rect, targetPath };
  }
  if (relY > 0.75) {
    return { edge: "bottom", instruction: "reorder-below", referenceRect: rect, targetPath };
  }
  return { edge: "inside", instruction: "make-child", referenceRect: rect, targetPath };
}

/**
 * Resolve the nearest child-edge drop among `children` (ports nearestChildEdge, canvas-dnd.ts). The
 * resulting `targetPath` is `[...parentPath, "children", closestIdx]` so the parent's
 * parentElementPath(slice(0,-2)) / childIndex(at(-1)) read the same parent + index.
 */
function nearestChildEdge(
  children: HTMLElement[],
  cursorY: number,
  parentPath: JxPath,
  src: DragSrcKind,
): DropPreview | null {
  let closestDist = Infinity;
  let instruction: "reorder-above" | "reorder-below" = "reorder-below";
  let closestIdx = children.length - 1;

  for (let i = 0; i < children.length; i++) {
    const rect = rectFor(children[i]!);
    const topDist = Math.abs(cursorY - rect.y);
    const bottomDist = Math.abs(cursorY - (rect.y + rect.height));
    if (topDist < closestDist) {
      closestDist = topDist;
      instruction = "reorder-above";
      closestIdx = i;
    }
    if (bottomDist < closestDist) {
      closestDist = bottomDist;
      instruction = "reorder-below";
      closestIdx = i;
    }
  }

  const childPath = [...parentPath, "children", closestIdx] as JxPath;
  if (!canDrop(src, childPath)) {
    return null;
  }
  return {
    edge: instruction === "reorder-above" ? "top" : "bottom",
    instruction,
    referenceRect: rectFor(children[closestIdx]!),
    targetPath: childPath,
  };
}

/** A tree-node may not drop onto its own subtree (ancestor-or-self); a block may always drop. */
function canDrop(src: DragSrcKind, targetPath: JxPath): boolean {
  if (src.type !== "tree-node") {
    return true;
  }
  const srcPath = src.path as JxPath;
  if (pathsEqual(srcPath, targetPath)) {
    return false;
  }
  return !isAncestor(srcPath, targetPath);
}

/** Read an element's iframe-viewport rect as a {@link DropPreview} `referenceRect`. */
export function rectFor(el: Element): DropPreview["referenceRect"] {
  const r = rectOf(el);
  return { height: r.height, width: r.width, x: r.x, y: r.y };
}

// ─── Auto-scroll (Phase 4c, commit 6) ──────────────────────────────────────────

/** Edge band height (px from the top/bottom of the viewport) that triggers auto-scroll. */
export const AUTO_SCROLL_BAND = 40;

/** Pixels scrolled per auto-scroll frame. */
export const AUTO_SCROLL_STEP = 12;

/**
 * The auto-scroll direction for a cursor `y` within a viewport of height `viewportH` (PURE).
 * Returns `-1` (scroll up) when the cursor is in the top `band`, `+1` (scroll down) in the bottom
 * `band`, or `0` outside both bands. The iframe's rAF loop multiplies this by
 * {@link AUTO_SCROLL_STEP} and keeps scrolling while it stays non-zero (a stationary edge-hold
 * self-sustains).
 */
export function scrollDirection(y: number, viewportH: number, band = AUTO_SCROLL_BAND): -1 | 0 | 1 {
  if (y < band) {
    return -1;
  }
  if (y > viewportH - band) {
    return 1;
  }
  return 0;
}
