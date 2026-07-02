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
import { rectOf, elementAtPoint } from "../utils/geometry";
import { getNodeAtPath, isAncestor, pathsEqual } from "../state";
import { isEditing } from "../editor/inline-edit";
import type { IframeChannel } from "./iframe-channel";
import type { DragSrcKind, DropPreview, IframeToParent, ParentToIframe } from "./iframe-protocol";
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
  const tag = (node?.tagName || "div").toLowerCase();
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
function rectFor(el: Element): DropPreview["referenceRect"] {
  const r = rectOf(el);
  return { height: r.height, width: r.width, x: r.x, y: r.y };
}

// ─── Flow 3: grab-anywhere drag detector (Phase 4c, commit 3; rebuilt 4c flow-3 fix) ──────────────
// The iframe owns no pragmatic-dnd, so an element-body drag is detected manually: a pointerdown on a
// `[data-jx-path]` arms a candidate, and the first pointermove past a small threshold posts
// `dragOriginate`. A drag that begins inside the iframe delivers its held-button pointermoves to the
// IFRAME document (implicit pointer capture), so the PARENT never sees them while the cursor is over
// The canvas. Flow 3 is therefore FULLY IFRAME-DRIVEN: after originating, the detector keeps driving
// — it computes the preview/drop LOCALLY from its own cursor (already iframe-viewport coords, no
// Parent->iframe round-trip) and posts dragOver/dropResult directly. The parent only adopts the
// Iframe's dragSeq, draws the indicator, positions the ghost from the posted cursor, and applies the
// Drop. (Flows 1/2/4 stay parent-originated: pragmatic's parent-document pointer stream does deliver
// Moves over the iframe for a drag that began in parent DOM, so those are sound and untouched.)

/** Pixels the pointer must travel from pointerdown before a body-grab counts as a drag. */
const GRAB_THRESHOLD = 4;

/**
 * Whether an iframe-originated (flow 3) drag is currently active. Read by iframe-keys to suppress
 * forwarding Escape to the parent during such a drag (the iframe owns cancel locally, see
 * {@link cancelIframeDrag}), and by the entry's dragEnd/dragCancel handling.
 */
let dragActive = false;

/** True while a flow-3 (iframe-originated) drag is live. */
export function isDragActive(): boolean {
  return dragActive;
}

/** The local cancel hook (clears preview/auto-scroll + posts dragEnd) installed by the active drag. */
let cancelHook: (() => void) | null = null;

/**
 * Cancel the active iframe-originated drag locally: clear any in-iframe drag state and run the
 * installed cancel hook (the entry posts `dragEnd` so the parent tears down ghost/indicator). A
 * no-op when no flow-3 drag is active. Single-sourced through here (and the parent's pragmatic
 * cancel for the parent-source flows) so cancel never double-fires.
 */
export function cancelIframeDrag(): void {
  if (!dragActive) {
    return;
  }
  const hook = cancelHook;
  clearIframeDrag();
  hook?.();
}

/** Reset the flow-3 drag state without firing the cancel hook (used on natural drop/dragEnd). */
export function clearIframeDrag(): void {
  dragActive = false;
  cancelHook = null;
}

/**
 * Mark a flow-3 drag active and register its local cancel hook. Called by the entry when it accepts
 * an iframe-originated session (after posting dragOriginate). Idempotent per drag.
 */
export function beginIframeDrag(onCancel: () => void): void {
  dragActive = true;
  cancelHook = onCancel;
}

/**
 * Whether a pointerdown on `target` may originate a body-grab drag: it must resolve to a
 * `[data-jx-path]` element and NOT be inside an active inline-edit session (typing/selecting text
 * must never start a reorder). Returns the resolved path, or null when no drag should originate.
 */
export function grabCandidatePath(target: EventTarget | null): JxPath | null {
  if (isEditing()) {
    return null;
  }
  const el = nearestPathEl(target instanceof Element ? target : null);
  if (!el) {
    return null;
  }
  return parseJxPath(el.dataset.jxPath as string) as JxPath;
}

/** Whether the pointer has moved past the grab threshold from its pointerdown origin (PURE). */
export function passedGrabThreshold(
  origin: { x: number; y: number },
  now: { x: number; y: number },
): boolean {
  return (
    Math.abs(now.x - origin.x) >= GRAB_THRESHOLD || Math.abs(now.y - origin.y) >= GRAB_THRESHOLD
  );
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

/**
 * The iframe-side capabilities the flow-3 detector needs to DRIVE a drag locally. Injected from
 * {@link file://./iframe-entry.ts} (the entry owns the render generation, the shadow doc, and the
 * self-sustaining auto-scroll loop) rather than duplicated here, so the detector and the
 * `dragMove`/`drop` message handlers share the EXACT same preview/drop math and auto-scroll state.
 */
export interface GrabDetectorDeps {
  /**
   * Resolve the display preview / authoritative drop for an IFRAME-VIEWPORT cursor (point hit-test
   * → nearest `[data-jx-path]` → pure {@link computeDropInstruction}); null when over no droppable.
   * Identical to the function the `dragMove`/`drop` handlers use — flow 3 takes the iframe-local
   * cursor DIRECTLY (no parentCursorToIframe; the iframe already owns its coordinate space).
   */
  previewAt: (cursor: { x: number; y: number }, src: DragSrcKind) => DropPreview | null;
  /** The generation the iframe's DOM currently reflects, so replies can be stale-gated parent-side. */
  gen: () => number;
  /**
   * Arm the self-sustaining auto-scroll loop for a flow-3 cursor. `src` lets the loop recompute the
   * preview during an edge-hold (the parent never posts a dragStart for flow 3, so the entry's own
   * `dragSrc` is null); the loop also re-posts dragOver WITH the cursor so the ghost keeps
   * tracking.
   */
  armAutoScroll: (cursor: { x: number; y: number }, dragSeq: number, src: DragSrcKind) => void;
  /** Stop the auto-scroll loop (on drop / band-exit / cancel). */
  stopAutoScroll: () => void;
}

/**
 * Wire the flow-3 grab detector on the iframe document and DRIVE the whole gesture locally (the
 * iframe owns the pointer it started — its held-button moves never reach the parent document).
 *
 * - Pointerdown on a node body (primary button, not while editing) arms a candidate.
 * - The first pointermove past {@link GRAB_THRESHOLD} originates: bumps the local seq, marks the drag
 *   active (with a cancel hook that posts `dragEnd`), posts `dragOriginate{path,dragSeq}`, and then
 *   immediately drives the first move.
 * - Every later pointermove computes the preview LOCALLY from its own (iframe-viewport) cursor and
 *   posts `dragOver{dragSeq, gen, preview, cursor}` (the parent positions the ghost from `cursor`)
 *   and updates auto-scroll.
 * - Pointerup computes the drop FRESH and posts `dropResult`, then tears down.
 *
 * The parent adopts this seq ({@link file://../panels/canvas-dnd-bridge.ts}'s
 * `startIframeOriginatedDrag` → `adoptDragSession`) so the dragOver/dropResult pass its seq gate;
 * it attaches NO parent-document listeners for flow 3. Returns a teardown. `deps` injects the
 * iframe-side preview/gen/auto-scroll capabilities (see {@link GrabDetectorDeps}).
 */
export function startGrabDetector(
  channel: IframeChannel<IframeToParent, ParentToIframe>,
  doc: Document = document,
  deps?: GrabDetectorDeps,
): () => void {
  let candidate: { path: JxPath; origin: { x: number; y: number } } | null = null;
  let localSeq = 0;
  // The realm-agnostic source kind for the live drag, kept in closure so previewAt's canDrop
  // (isAncestor/self) sees the grabbed node's path for the whole gesture.
  let src: DragSrcKind | null = null;

  const onPointerDown = (e: PointerEvent) => {
    // Only a primary-button drag originates; ignore right/middle and multi-touch gestures.
    if (e.button !== 0) {
      return;
    }
    const path = grabCandidatePath(e.target);
    if (!path) {
      return;
    }
    candidate = { origin: { x: e.clientX, y: e.clientY }, path };
  };

  // A REAL mouse press-drag over an <img> (draggable by default) or a text selection starts a
  // NATIVE HTML5 drag, which fires pointercancel and hijacks the pointer stream — the grab dies
  // Before it originates (synthetic/CDP input never triggers this, which is why only real-mouse
  // Drags broke). While a grab candidate is armed or a drag is live, native drags are never wanted;
  // Outside that (no path target, inline editing) native behavior is preserved.
  const onDragStart = (e: Event) => {
    if (candidate || dragActive) {
      e.preventDefault();
    }
  };

  // Suppress text selection only while the drag is LIVE (plain clicks and inline editing keep
  // Native selection); the origination path below also clears any selection the pre-threshold
  // Moves already started.
  const onSelectStart = (e: Event) => {
    if (dragActive) {
      e.preventDefault();
    }
  };

  /** Compute + post the dragOver preview for the live cursor, and (re)arm auto-scroll. */
  const drive = (cursor: { x: number; y: number }) => {
    if (!src) {
      return;
    }
    const preview = deps ? deps.previewAt(cursor, src) : null;
    channel.post({
      cursor,
      dragSeq: localSeq,
      gen: deps ? deps.gen() : -1,
      kind: "dragOver",
      preview,
    });
    deps?.armAutoScroll(cursor, localSeq, src);
  };

  const onPointerMove = (e: PointerEvent) => {
    const cursor = { x: e.clientX, y: e.clientY };
    if (!dragActive) {
      if (!candidate || !passedGrabThreshold(candidate.origin, cursor)) {
        return;
      }
      localSeq += 1;
      const { path } = candidate;
      candidate = null;
      src = { path: [...path], type: "tree-node" };
      beginIframeDrag(() => channel.post({ dragSeq: localSeq, kind: "dragEnd" }));
      // Drop any text selection the pre-threshold moves started (real-mouse drags select as they
      // Go); onSelectStart keeps new selections suppressed for the rest of the gesture.
      doc.getSelection?.()?.removeAllRanges();
      channel.post({ dragSeq: localSeq, kind: "dragOriginate", path: [...path] });
      // Fall through and drive the first move immediately (the originating move is also a move).
    }
    drive(cursor);
  };

  const onPointerUp = (e: PointerEvent) => {
    candidate = null;
    if (!dragActive || !src) {
      return;
    }
    const cursor = { x: e.clientX, y: e.clientY };
    const drop = deps ? deps.previewAt(cursor, src) : null;
    channel.post({
      dragSeq: localSeq,
      gen: deps ? deps.gen() : -1,
      instruction: drop ? drop.instruction : null,
      kind: "dropResult",
      targetPath: drop ? drop.targetPath : null,
    });
    src = null;
    deps?.stopAutoScroll();
    clearIframeDrag();
  };

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointermove", onPointerMove, true);
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("dragstart", onDragStart, true);
  doc.addEventListener("selectstart", onSelectStart, true);

  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("pointermove", onPointerMove, true);
    doc.removeEventListener("pointerup", onPointerUp, true);
    doc.removeEventListener("dragstart", onDragStart, true);
    doc.removeEventListener("selectstart", onSelectStart, true);
  };
}
