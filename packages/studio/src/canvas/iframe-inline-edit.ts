/// <reference lib="dom" />
/**
 * In-iframe inline editing — runs the contenteditable session INSIDE the canvas iframe (Selection /
 * Range / execCommand are per-realm singletons bound to their document, so the editing must happen
 * where the edited DOM lives) and posts the serializable results to the parent, which applies them
 * via transactDoc. Double-click enters editing; the parent posts `enterEdit` to re-enter on the new
 * element after a split/insert re-renders.
 *
 * Phase 4b-2 adds the format-toolbar bridge: the iframe owns the Selection and posts a serializable
 * `selectionChanged` snapshot (active tags + caret rect + link state + seq); the parent toolbar
 * renders pressed-state/position from it and posts `applyFormat` intents back, which this module
 * applies to the iframe's cached range. The parent NEVER reads the iframe DOM/Selection.
 *
 * NOTE ON REALM ISOLATION (unit tests can't prove it): the session engine (`inline-edit.ts` +
 * `inline-format.ts`) and `inline-link.ts` are bundled into the iframe and use ambient
 * `window`/`document`, so at runtime `window === iframe.contentWindow`. Under happy-dom there is
 * one shared global, so the cross-realm focus/Selection behavior (a parent-toolbar click blurring
 * the iframe; CSS Custom Highlight painting) is STRUCTURAL, verified by CDP — not by this unit
 * suite.
 */

import {
  getActiveElement,
  isEditableBlock,
  isEditing,
  isSlashActive,
  resumeBlurClose,
  startEditing,
  stopEditing,
  suspendBlurClose,
} from "../editor/inline-edit";
import { isTagActiveInSelection, toggleInlineFormat } from "../editor/inline-format";
import { applyLink, insertTemplateToken, linkStateForSelection } from "../editor/inline-link";
import { restoreTemplateExpressions } from "../utils/edit-display";
import { rectOfRange } from "../utils/geometry";
import { parseJxPath, serializeJxPath } from "./path-mapping";
import type { IframeChannel } from "./iframe-channel";
import type {
  ApplyFormatIntent,
  IframeToParent,
  ParentToIframe,
  SelectionSnapshot,
  SerializableRect,
} from "./iframe-protocol";
import type { JxPath } from "../state";

/** Toolbar command → inline tag (mirrors the parent's old `cmdToTag`, now iframe-side). */
const CMD_TO_TAG: Record<string, string> = {
  bold: "strong",
  code: "code",
  italic: "em",
  strikethrough: "del",
  subscript: "sub",
  superscript: "sup",
  underline: "u",
};

/** Inline tags whose active state the snapshot reports (everything except `a`, handled via link). */
const ACTIVE_TAG_PROBES = ["strong", "em", "u", "del", "sub", "sup", "code"];

/** CSS Custom Highlight name + the id of the injected `::highlight()` style rule. */
const HIGHLIGHT_NAME = "jx-pending-format";
const HIGHLIGHT_STYLE_ID = "jx-pending-format-style";

/** Walk up from an event target to the nearest editable element carrying a `data-jx-path`. */
function findEditableTarget(target: EventTarget | null): { el: HTMLElement; path: JxPath } | null {
  let el = target instanceof Element ? target : null;
  while (el) {
    if (el instanceof HTMLElement && el.dataset.jxPath && isEditableBlock(el)) {
      return { el, path: parseJxPath(el.dataset.jxPath) };
    }
    el = el.parentElement;
  }
  return null;
}

/** Locate the rendered element for a document path via its stamped `data-jx-path`. */
function elementForPath(container: HTMLElement, path: JxPath): HTMLElement | null {
  const serialized = serializeJxPath(path);
  const esc = serialized.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`);
  const el = container.querySelector(`[data-jx-path='${esc}']`);
  return el instanceof HTMLElement ? el : null;
}

/** A DOMRect → the serializable rect shape the snapshot carries (iframe-viewport coords). */
function toSerializableRect(rect: DOMRect): SerializableRect {
  return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
}

/**
 * Wire double-click → inline editing on `container`'s editable elements, the parent `enterEdit`
 * re-entry, the selection-snapshot post stream, and the `applyFormat` apply path. The session's
 * onCommit/onSplit/onInsert/onEnd results are posted to the parent. Returns a teardown function.
 */
export function startIframeInlineEdit(
  channel: IframeChannel<IframeToParent, ParentToIframe>,
  container: HTMLElement,
): () => void {
  const doc = container.ownerDocument;

  // The most recent non-empty range inside the active editable. Cached AGGRESSIVELY (not just on
  // Selectionchange) because focus can collapse the live selection before the post-blur event runs.
  let lastNonEmptyRange: Range | null = null;
  // Monotonic per session; the parent drops stale snapshots.
  let seq = 0;

  /** The live selection's first range, if it sits inside the active editable. */
  const liveRangeInEditable = (el: HTMLElement): Range | null => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      return null;
    }
    const range = sel.getRangeAt(0);
    return el.contains(range.commonAncestorContainer) ? range : null;
  };

  /** Cache the live range when it's non-empty and inside the active editable. */
  const cacheRange = () => {
    const el = getActiveElement();
    if (!el) {
      return;
    }
    const range = liveRangeInEditable(el);
    if (range && !range.collapsed) {
      lastNonEmptyRange = range.cloneRange();
    }
  };

  /**
   * Inject the `::highlight()` rule once so the cached range is visible while the toolbar has
   * focus.
   */
  const ensureHighlightStyle = () => {
    if (doc.querySelector(`#${HIGHLIGHT_STYLE_ID}`)) {
      return;
    }
    const style = doc.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: Highlight; color: HighlightText; }`;
    doc.head.append(style);
  };

  /**
   * Paint (or clear) the cached range via the CSS Custom Highlight API so the selection stays
   * visible while the parent link-URL field is focused. Feature-detected: happy-dom lacks
   * `Highlight`/`CSS.highlights`, so this is a silent no-op there (and in non-Chromium engines).
   */
  const updateHighlight = () => {
    const HighlightCtor = (globalThis as { Highlight?: unknown }).Highlight as
      | (new (range: Range) => unknown)
      | undefined;
    const highlights = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> })
      ?.highlights;
    if (!HighlightCtor || !highlights) {
      return;
    }
    if (lastNonEmptyRange && lastNonEmptyRange.startContainer.isConnected) {
      ensureHighlightStyle();
      highlights.set(HIGHLIGHT_NAME, new HighlightCtor(lastNonEmptyRange.cloneRange()));
    } else {
      highlights.delete(HIGHLIGHT_NAME);
    }
  };

  /** Tear down the Custom Highlight (on teardown / real editEnd). */
  const clearHighlight = () => {
    const highlights = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> })
      ?.highlights;
    highlights?.delete(HIGHLIGHT_NAME);
  };

  /**
   * Build the serializable selection snapshot from the live selection (falling back to the cached
   * range for geometry when the live one collapsed). Returns null when no session is active.
   */
  const buildSnapshot = (): SelectionSnapshot | null => {
    const el = getActiveElement();
    if (!el || !el.dataset.jxPath) {
      return null;
    }
    const liveRange = liveRangeInEditable(el);
    const geomRange = liveRange ?? lastNonEmptyRange;
    const rect = geomRange ? toSerializableRect(rectOfRange(geomRange)) : null;
    const collapsed = liveRange ? liveRange.collapsed : true;

    const activeTags = ACTIVE_TAG_PROBES.filter((tag) => isTagActiveInSelection(tag, el));
    const link = linkStateForSelection(el);
    if (link.active) {
      activeTags.push("a");
    }

    seq += 1;
    return {
      activeTags,
      collapsed,
      kind: "selectionChanged",
      link,
      localScope: null,
      path: parseJxPath(el.dataset.jxPath),
      rect,
      seq,
    };
  };

  /** Recompute + post a snapshot (and repaint the highlight) when a session is live. */
  const onSelectionChange = () => {
    if (!isEditing()) {
      return;
    }
    // Cache the (possibly just-changed) live range BEFORE painting/snapshotting so the highlight and
    // The snapshot reflect the current selection — selectionchange is one of the aggressive triggers.
    cacheRange();
    updateHighlight();
    const snapshot = buildSnapshot();
    if (snapshot) {
      channel.post(snapshot);
    }
  };

  const enterEditAt = (el: HTMLElement, path: JxPath) => {
    // Show raw `${expr}` syntax for editing (the render displays it as ❪ expr ❫).
    restoreTemplateExpressions(el);
    channel.post({ kind: "editStart", path });
    // While the session is live the parent toolbar/popover may take focus — a blur must not tear
    // The session down across the bridge (focus-loss BLOCKER fix).
    suspendBlurClose();
    startEditing(el, path, {
      onCommit: (p, children, textContent) =>
        channel.post({ children, kind: "editCommit", path: p, textContent }),
      onEnd: () => {
        // A real session end: stop suspending blur-close and drop the selection viz.
        resumeBlurClose();
        clearHighlight();
        lastNonEmptyRange = null;
        channel.post({ kind: "editEnd" });
      },
      onInsert: (p, cmd, commitData) =>
        channel.post({ cmd, commitData, kind: "editInsert", path: p }),
      onSplit: (p, before, after) => channel.post({ after, before, kind: "editSplit", path: p }),
    });
    // Post an initial (collapsed-caret) snapshot so the toolbar shows on entry.
    cacheRange();
    onSelectionChange();
  };

  /** Apply a format/link/insert intent to the iframe's cached selection range. */
  const applyFormatIntent = (intent: ApplyFormatIntent) => {
    const el = getActiveElement();
    if (!el) {
      return; // Session not active → no-op.
    }
    // Restore the cached range ONLY if it's still usable (the DOM may have re-rendered).
    if (
      lastNonEmptyRange &&
      lastNonEmptyRange.startContainer.isConnected &&
      el.contains(lastNonEmptyRange.commonAncestorContainer)
    ) {
      const sel = window.getSelection();
      el.focus();
      sel?.removeAllRanges();
      sel?.addRange(lastNonEmptyRange);
    }

    if (intent.command === "link") {
      applyLink(el, intent.href);
    } else if (intent.command === "insertData") {
      insertTemplateToken(el, intent.token);
    } else {
      const tag = CMD_TO_TAG[intent.command];
      if (tag) {
        toggleInlineFormat(tag, el);
      }
    }

    // Re-emit so the parent's pressed-state/position updates. The parent guards re-render of an
    // OPEN link popover (so this won't yank a mid-edit URL field).
    cacheRange();
    onSelectionChange();
  };

  const onDblClick = (e: Event) => {
    const hit = findEditableTarget(e.target);
    if (hit) {
      enterEditAt(hit.el, hit.path);
    }
  };

  const onMouseUp = () => cacheRange();
  const onKeyUp = () => cacheRange();
  // Capture-phase blur: cache the range before focus moves out (the bubbling blur fires too late).
  const onBlurCapture = () => cacheRange();

  /**
   * Commit-on-click-away: a pointerdown INSIDE the iframe but OUTSIDE the active editable ends the
   * session (committing via the engine's stopEditing → onCommit). Blur-close stays suspended for
   * the whole session (a parent-toolbar click across the bridge must not kill it), so without this
   * an in-canvas click-away would never commit — text edits would never reach the document.
   */
  const onPointerDownCapture = (e: Event) => {
    if (!isEditing() || isSlashActive()) {
      return;
    }
    const el = getActiveElement();
    if (el && e.target instanceof Node && !el.contains(e.target)) {
      stopEditing();
    }
  };

  doc.addEventListener("dblclick", onDblClick, true);
  doc.addEventListener("selectionchange", onSelectionChange);
  doc.addEventListener("mouseup", onMouseUp, true);
  doc.addEventListener("keyup", onKeyUp, true);
  doc.addEventListener("blur", onBlurCapture, true);
  doc.addEventListener("pointerdown", onPointerDownCapture, true);

  const off = channel.onMessage((msg) => {
    if (msg.kind === "applyFormat") {
      applyFormatIntent(msg.intent);
      return;
    }
    if (msg.kind === "endEdit") {
      // The parent detected intent leaving the edit surface in ITS realm (tab switch, chrome click
      // Outside the edit toolbars) — commit and end, a no-op when no session is live.
      if (isEditing()) {
        stopEditing();
      }
      return;
    }
    if (msg.kind !== "enterEdit") {
      return;
    }
    const el = elementForPath(container, msg.path);
    if (el && isEditableBlock(el)) {
      enterEditAt(el, msg.path);
    }
  });

  return () => {
    doc.removeEventListener("dblclick", onDblClick, true);
    doc.removeEventListener("selectionchange", onSelectionChange);
    doc.removeEventListener("mouseup", onMouseUp, true);
    doc.removeEventListener("keyup", onKeyUp, true);
    doc.removeEventListener("blur", onBlurCapture, true);
    doc.removeEventListener("pointerdown", onPointerDownCapture, true);
    off();
    clearHighlight();
    lastNonEmptyRange = null;
    resumeBlurClose();
    if (isEditing()) {
      stopEditing();
    }
  };
}
