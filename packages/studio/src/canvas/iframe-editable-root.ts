/// <reference lib="dom" />
/**
 * The canvas editing host — the mechanics of a document-wide caret.
 *
 * The canvas container is a single `contenteditable` (see `syncEditableRoot`), so the browser owns
 * everything it is genuinely good at: placing the caret where you clicked, moving it across block
 * boundaries with line-wrap-aware Up/Down, Home/End, word motion, IME, and drag-selecting across
 * paragraphs. There is no "edit session" to enter and no modal state — the caret simply exists.
 *
 * This module owns three things and nothing else:
 *
 * 1. **Which block the caret is in**, derived from `selectionchange` rather than stored. Entering and
 *    leaving a block are reported to the bridge, which is where commits and the parent's
 *    selection/toolbar state live.
 * 2. **The `beforeinput` chokepoint.** Structural intents are prevented and handed to the document
 *    model; single-block text edits run natively. The decision itself is pure and lives in
 *    {@link file://./editable-actions.ts}.
 * 3. **Caret capture/restore in model coordinates**, so a surgical patch can rewrite the DOM under a
 *    live caret without the caret jumping (see {@link file://./iframe-position.ts}).
 *
 * A structural handler that is absent SUPPRESSES its action rather than falling back to the
 * browser's own restructuring — an unimplemented merge must leave the document untouched, never let
 * the engine silently join two blocks behind the model's back.
 */

import { classifyBeforeInput } from "./editable-actions";
import {
  activeBlockAt,
  blockTextLength,
  isAtBlockStart,
  samePath,
  toDocPos,
  toDomPosition,
} from "./iframe-position";
import { serializeJxPath } from "./path-mapping";
import type { DocPos, DocRange, EditablePredicate } from "./iframe-position";
import type { JxPath } from "../state";

/**
 * The capabilities the editing host needs from its bridge. Injected rather than imported so the
 * host stays free of the channel/protocol layer, mirroring `InteractionDeps` and
 * `GrabDetectorDeps`.
 */
export interface EditableRootDeps {
  /** The live render's canvas mode; the caret exists only in design/edit. Absent = permissive. */
  getMode?: () => string;
  /** Which elements may hold a caret. */
  isEditableBlock: EditablePredicate;
  /** The caret entered a block. */
  onActivate: (el: HTMLElement, path: JxPath) => void;
  /** The caret left the active block (or the canvas). */
  onDeactivate: () => void;
  /** The selection moved WITHIN the active block. */
  onSelectionChange?: () => void;
  /**
   * A prop-bound component-internal marker was pressed. Returns whether it was activated — the
   * bridge decides, since only it can see the raw `$props` value behind the binding.
   */
  onPropActivate?: (el: HTMLElement) => boolean;
  /** Split the active block at the caret. Returns whether it was handled. */
  onSplit?: () => boolean;
  /** Join the block at `at` onto the previous one. Returns whether it was handled. */
  onMergeBackward?: (at: DocPos) => boolean;
  /** Pull the next block up into the one at `at`. Returns whether it was handled. */
  onMergeForward?: (at: DocPos) => boolean;
  /** Replace `[from, to)` — possibly spanning blocks — with `text`. Returns whether it was handled. */
  onReplaceRange?: (from: DocPos, to: DocPos, text: string) => boolean;
}

/** The selection's current endpoints in document coordinates, or null when it is outside the canvas. */
export function captureDocSelection(
  container: HTMLElement,
  isEditable: EditablePredicate,
): DocRange | null {
  const sel = container.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) {
    return null;
  }
  if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) {
    return null;
  }
  const anchor = toDocPos(sel.anchorNode, sel.anchorOffset, isEditable);
  const head = toDocPos(sel.focusNode, sel.focusOffset, isEditable);
  return anchor && head ? { anchor, head } : null;
}

/**
 * Put the selection back at `range`'s document coordinates. Returns false when neither endpoint's
 * block still renders — the caller then leaves the caret wherever the browser put it rather than
 * moving it somewhere arbitrary.
 */
export function restoreDocSelection(container: HTMLElement, range: DocRange): boolean {
  const anchor = toDomPosition(container, range.anchor);
  const head = toDomPosition(container, range.head) ?? anchor;
  if (!anchor) {
    return false;
  }
  const sel = container.ownerDocument.getSelection();
  if (!sel) {
    return false;
  }
  const domRange = container.ownerDocument.createRange();
  domRange.setStart(anchor.node, anchor.offset);
  sel.removeAllRanges();
  sel.addRange(domRange);
  if (head && head !== anchor) {
    sel.extend(head.node, head.offset);
  }
  return true;
}

/** The editing host's control surface. */
export interface EditableRootHandle {
  /** Tear the host down. */
  stop: () => void;
  /**
   * Re-derive the active block from the live selection. Call after moving the selection
   * programmatically — `selectionchange` is dispatched as a task, so a caller that needs the
   * activation to have happened before it returns cannot wait for the event.
   */
  sync: () => void;
  /** Put the caret at a document position and activate its block. False when the path is gone. */
  placeCaret: (pos: DocPos) => boolean;
  /** The current selection in document coordinates, or null when it is outside the canvas. */
  capture: () => DocRange | null;
  /** Restore a captured selection and re-activate its block. */
  restore: (range: DocRange) => boolean;
}

/** Wire the editing host on `container`. */
export function startEditableRoot(
  container: HTMLElement,
  deps: EditableRootDeps,
): EditableRootHandle {
  const doc = container.ownerDocument;
  /** The element the caret is currently editing — a page block, or a prop-bound nested host. */
  let activeEl: HTMLElement | null = null;
  /** Its serialized document path. Null for a prop-bound host, which has no path of its own. */
  let activeKey: string | null = null;

  const editingAllowed = () => {
    const mode = deps.getMode?.();
    return mode === undefined || mode === "design" || mode === "edit";
  };

  /** Release whatever is active, if anything. */
  const deactivate = () => {
    if (!activeEl) {
      return;
    }
    activeEl = null;
    activeKey = null;
    deps.onDeactivate();
  };

  /**
   * Re-derive the active block from the live selection.
   *
   * This is the whole "enter editing" flow: there is no gesture to recognise, because a caret
   * inside a block IS the edit. Click, arrow, Home, a restored caret after a patch — every one of
   * them arrives here the same way.
   */
  const syncActiveBlock = () => {
    if (!editingAllowed()) {
      deactivate();
      return;
    }
    const sel = doc.getSelection();
    const focus = sel?.focusNode ?? null;
    if (!focus) {
      // An ABSENT selection is transient, not intent: a re-render, a `removeAllRanges()`, or the
      // Window losing focus all momentarily empty it. Deactivating here would commit and drop the
      // Caret's block for what is about to become the very same selection again. Only a selection
      // That has genuinely moved somewhere else releases the block.
      return;
    }
    if (!container.contains(focus)) {
      deactivate();
      return;
    }
    const block = activeBlockAt(focus, deps.isEditableBlock);
    if (!block) {
      // No stamped block — but a prop-bound nested host has no `data-jx-path` of its own, so a
      // Caret still inside the active element is the session continuing, not leaving it. Without
      // This, opening a prop-bound host would tear itself down on its own first selectionchange.
      if (activeEl?.contains(focus)) {
        deps.onSelectionChange?.();
        return;
      }
      deactivate();
      return;
    }
    const key = serializeJxPath(block.path);
    if (key === activeKey) {
      deps.onSelectionChange?.();
      return;
    }
    // Leaving a block is what flushes its content to the document, so the order matters: the old
    // Block must be released before the new one is activated.
    deactivate();
    activeEl = block.el;
    activeKey = key;
    deps.onActivate(block.el, block.path);
  };

  /**
   * Resolve the range a `beforeinput` will affect, in model coordinates.
   *
   * `getTargetRanges()` is authoritative in Chromium (it reports what the engine is ABOUT to touch,
   * which for a backward delete is a real range, not the collapsed caret). It is absent on
   * synthetic events and empty for some input types, so the live selection is the fallback.
   */
  const affectedRange = (
    e: InputEvent,
  ): { from: DocPos; to: DocPos; endEl: HTMLElement } | null => {
    const [target] = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : [];
    let startNode: Node | null;
    let startOffset: number;
    let endNode: Node | null;
    let endOffset: number;
    if (target) {
      ({ startContainer: startNode, startOffset, endContainer: endNode, endOffset } = target);
    } else {
      const sel = doc.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return null;
      }
      const r = sel.getRangeAt(0);
      ({ startContainer: startNode, startOffset, endContainer: endNode, endOffset } = r);
    }
    const from = toDocPos(startNode, startOffset, deps.isEditableBlock);
    const to = toDocPos(endNode, endOffset, deps.isEditableBlock);
    const endBlock = activeBlockAt(endNode, deps.isEditableBlock);
    return from && to && endBlock ? { endEl: endBlock.el, from, to } : null;
  };

  const onBeforeInput = (event: Event) => {
    const e = event as InputEvent;
    if (!editingAllowed()) {
      return;
    }
    const resolved = affectedRange(e);
    const action = classifyBeforeInput({
      atBlockEnd: resolved ? resolved.to.offset >= blockTextLength(resolved.endEl) : false,
      atBlockStart: resolved ? isAtBlockStart(resolved.from) : false,
      data: e.data ?? "",
      from: resolved?.from ?? null,
      inputType: e.inputType,
      to: resolved?.to ?? null,
    });

    switch (action.kind) {
      case "native": {
        return;
      }
      case "split": {
        // A split whose range spans two blocks would have to delete across the boundary first;
        // Without a range handler there is no correct way to do that, so suppress rather than
        // Silently drop the far half.
        e.preventDefault();
        if (!samePath(action.from, action.to) && !deps.onReplaceRange) {
          return;
        }
        deps.onSplit?.();
        return;
      }
      case "mergeBackward": {
        e.preventDefault();
        deps.onMergeBackward?.(action.at);
        return;
      }
      case "mergeForward": {
        e.preventDefault();
        deps.onMergeForward?.(action.at);
        return;
      }
      case "replaceRange": {
        e.preventDefault();
        deps.onReplaceRange?.(action.from, action.to, action.text);
        return;
      }
      default: {
        // "reject" — the browser must not act, and there is nothing for us to do either.
        e.preventDefault();
      }
    }
  };

  /**
   * Prop-bound component internals sit inside a `contenteditable="false"` island, so a click alone
   * cannot put a caret in them. Capture-phase pointerdown gives the bridge a chance to open a
   * nested editing host BEFORE the browser computes the caret, so the click still lands where it
   * was aimed.
   */
  const onPointerDownCapture = (e: Event) => {
    if (!editingAllowed() || !deps.onPropActivate) {
      return;
    }
    let el = e.target instanceof Element ? (e.target as HTMLElement) : null;
    while (el && el !== container) {
      if (el.dataset?.jxBoundProp) {
        if (el !== activeEl) {
          deactivate();
          if (deps.onPropActivate(el)) {
            // Adopt the nested host so the caret landing inside it is not read as a block change.
            activeEl = el;
            activeKey = null;
          }
        }
        return;
      }
      // A stamped page block first means this is ordinary page DOM, not component internals.
      if (el.dataset?.jxPath) {
        return;
      }
      el = el.parentElement;
    }
  };

  /**
   * Reordering is the block action bar's drag handle, full stop. A `contenteditable` region is
   * natively draggable by its text, which would both fight text selection and move content behind
   * the document model's back.
   */
  const onDragStart = (e: Event) => {
    e.preventDefault();
  };

  doc.addEventListener("selectionchange", syncActiveBlock);
  container.addEventListener("beforeinput", onBeforeInput);
  container.addEventListener("dragstart", onDragStart);
  doc.addEventListener("pointerdown", onPointerDownCapture, true);

  return {
    capture: () => captureDocSelection(container, deps.isEditableBlock),
    placeCaret: (pos) => {
      const ok = restoreDocSelection(container, { anchor: pos, head: pos });
      if (ok) {
        syncActiveBlock();
      }
      return ok;
    },
    restore: (range) => {
      const ok = restoreDocSelection(container, range);
      if (ok) {
        syncActiveBlock();
      }
      return ok;
    },
    stop: () => {
      doc.removeEventListener("selectionchange", syncActiveBlock);
      container.removeEventListener("beforeinput", onBeforeInput);
      container.removeEventListener("dragstart", onDragStart);
      doc.removeEventListener("pointerdown", onPointerDownCapture, true);
      deactivate();
    },
    sync: syncActiveBlock,
  };
}
