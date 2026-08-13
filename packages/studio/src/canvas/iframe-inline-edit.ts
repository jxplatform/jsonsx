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
  commitActiveBlock,
  getActiveElement,
  handleSlashTrigger,
  isEditableBlock,
  isEditing,
  isSlashActive,
  openSlashMenu,
  refreshSlashMenu,
  splitActiveBlock,
  startEditing,
  stopEditing,
} from "../editor/inline-edit";
import { startEditableRoot } from "./iframe-editable-root";
import { adjacentBlock, blocksInOrder } from "./iframe-position";
import { isTagActiveInSelection, toggleInlineFormat } from "../editor/inline-format";
import { applyLink, insertTemplateToken, linkStateForSelection } from "../editor/inline-link";
import { restoreTemplateExpressions } from "../utils/edit-display";
import { rectOfRange } from "../utils/geometry";
import { getNodeAtPath } from "../state";
import { parseJxPath, serializeJxPath } from "./path-mapping";
import type { IframeChannel } from "./iframe-channel";
import type {
  ApplyFormatIntent,
  IframeToParent,
  ParentToIframe,
  SelectionSnapshot,
  SerializableRect,
} from "./iframe-protocol";
import type { DocPos } from "./iframe-position";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";

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

/**
 * The instance that owns a prop-bound element: its nearest custom-element ancestor (that element's
 * connectedCallback rendered the marker with its state, so the walk can never skip the owner).
 */
function ownerInstanceOf(el: HTMLElement): HTMLElement | null {
  let cur = el.parentElement;
  while (cur) {
    if (cur.tagName.includes("-")) {
      return cur;
    }
    cur = cur.parentElement;
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
  opts?: { getMode?: () => string; getShadowDoc?: () => JxMutableNode | null },
): () => void {
  const doc = container.ownerDocument;

  // Inline editing exists only in design/edit renders — a stylebook (or preview) render must not
  // Start a contenteditable session on its nodes. An absent getMode is permissive (tests).
  const editingAllowed = () => {
    const mode = opts?.getMode?.();
    return mode === undefined || mode === "design" || mode === "edit";
  };

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
    startEditing(el, path, {
      // `inPlace` rides along only when set: a release commit is the common case and the flag is
      // Optional, so omitting it keeps the message shape unchanged for every non-tick commit.
      onCommit: (p, children, textContent, inPlace) =>
        channel.post({
          children,
          kind: "editCommit",
          path: p,
          textContent,
          ...(inPlace ? { inPlace: true } : {}),
        }),
      onEnd: () => {
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

  /**
   * Whether the instance's RAW `$props[prop]` value (from the pre-edit-display shadow doc) is
   * plain-text editable. Template-valued (`"${...}"`) and `$ref`-valued props render display sugar,
   * not the value — committing typed text would silently destroy the binding, so they're blocked.
   * An absent getShadowDoc is permissive (tests, same contract as getMode).
   */
  const propEditableAt = (hostPath: JxPath, prop: string): boolean => {
    const shadowDoc = opts?.getShadowDoc?.();
    if (!shadowDoc) {
      return true;
    }
    const node = getNodeAtPath(shadowDoc, hostPath) as JxMutableNode | undefined;
    const raw = (node?.$props as Record<string, unknown> | undefined)?.[prop];
    if (raw == null) {
      return true; // Unset — editing ADDS the prop, overriding the definition default.
    }
    if (typeof raw === "object") {
      return false;
    }
    return !(typeof raw === "string" && raw.includes("${"));
  };

  /**
   * Enter a plain (plaintext-only) session on a prop-bound component-internal element. The session
   * path is the INSTANCE path — the marker element has no path of its own, and an external `$props`
   * patch at the host path must disturb (commit + end) this session before detaching its element.
   */
  const enterPropEditAt = (el: HTMLElement, hostPath: JxPath, prop: string) => {
    channel.post({ kind: "editStart", path: hostPath, prop });
    startEditing(
      el,
      hostPath,
      {
        onCommit: (p, _children, textContent, inPlace) =>
          channel.post({
            kind: "editCommitProp",
            path: p,
            prop,
            value: textContent ?? "",
            ...(inPlace ? { inPlace: true } : {}),
          }),
        onEnd: () => {
          clearHighlight();
          lastNonEmptyRange = null;
          channel.post({ kind: "editEnd" });
        },
        // Prop values are single plain strings — no split, no slash-insert.
        onInsert: () => {},
        onSplit: () => {},
      },
      { plainText: true },
    );
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

  /**
   * Open a nested editing host on a prop-bound component-internal marker. Returns whether it was
   * activated — a path-less owner is itself internal to another definition, so its `$props` live in
   * a document that is not open in this tab and there is no write-back target.
   */
  const activateProp = (el: HTMLElement): boolean => {
    const prop = el.dataset.jxBoundProp;
    const host = ownerInstanceOf(el);
    const hostPathRaw = host?.dataset.jxPath;
    if (!prop || !host || !hostPathRaw) {
      return false;
    }
    const hostPath = parseJxPath(hostPathRaw);
    if (!propEditableAt(hostPath, prop)) {
      return false;
    }
    enterPropEditAt(el, hostPath, prop);
    return true;
  };

  /**
   * Post a join between the block at `path` and its document-order neighbour.
   *
   * `direction` is which way the caret was deleting: backward joins this block onto the previous
   * one, forward pulls the next one up into this. Either way the surviving block is the earlier of
   * the two, so the caret ends at the seam inside it. Returns false at the document's ends, where
   * the chokepoint then suppresses the keystroke rather than doing nothing visible.
   */
  const postMerge = (path: JxPath, direction: -1 | 1): boolean => {
    const neighbour = adjacentBlock(container, path, direction, isEditableBlock);
    if (!neighbour) {
      return false;
    }
    const [fromPath, intoPath] = direction === -1 ? [path, neighbour.path] : [neighbour.path, path];
    // Commit what the caret has typed but not yet flushed, or the merge would join the block's
    // Last COMMITTED content and silently drop the rest.
    root.flush();
    channel.post({ fromPath, intoPath, kind: "editMerge" });
    return true;
  };

  /**
   * Post a collapse of the selection spanning `from`..`to`.
   *
   * The blocks strictly between the endpoints are listed here, from the rendered DOM, because that
   * is where document order is already correct — a range can span list items, table cells, and
   * nested containers, none of which is a flat index walk.
   */
  const postRangeReplace = (from: DocPos, to: DocPos, text: string): boolean => {
    const blocks = blocksInOrder(container, isEditableBlock);
    const fromKey = serializeJxPath(from.path);
    const toKey = serializeJxPath(to.path);
    const start = blocks.findIndex((el) => el.dataset.jxPath === fromKey);
    const end = blocks.findIndex((el) => el.dataset.jxPath === toKey);
    if (start === -1 || end === -1 || end <= start) {
      return false;
    }
    const between = blocks
      .slice(start + 1, end)
      .map((el) => parseJxPath(el.dataset.jxPath as string));
    // Commit pending text in the active block first, or the collapse would splice the block's last
    // COMMITTED content and silently drop whatever was typed since.
    root.flush();
    channel.post({ between, from, kind: "editRangeReplace", text, to });
    return true;
  };

  const onMouseUp = () => cacheRange();
  const onKeyUp = () => cacheRange();
  // Capture-phase blur: cache the range before focus moves out (the bubbling blur fires too late).
  const onBlurCapture = () => cacheRange();

  /**
   * The editing host. Activation is now purely a consequence of where the caret is — there is no
   * gesture to recognise and no session to enter, which is what makes a single click (or an arrow
   * key, or Home) land you in a block ready to type.
   *
   * Only `onSplit` is wired here: block merges and cross-block range edits are recognised by the
   * chokepoint but have no document mutation behind them yet, and an absent handler SUPPRESSES the
   * action rather than letting the browser restructure the DOM behind the model's back.
   */
  const root = startEditableRoot(container, {
    getMode: () => opts?.getMode?.() ?? "edit",
    isEditableBlock,
    onActivate: (el, path) => enterEditAt(el, path),
    onDeactivate: () => {
      // Leaving a block is what flushes it to the document.
      if (isEditing()) {
        stopEditing();
      }
    },
    onCommitTick: () => commitActiveBlock(),
    // Backspace at a block's start and Delete at its end are the same join, approached from either
    // Side. The neighbour is resolved HERE because document order lives in the rendered DOM.
    onMergeBackward: (at) => postMerge(at.path, -1),
    onMergeForward: (at) => postMerge(at.path, 1),
    onReplaceRange: (from, to, text) => postRangeReplace(from, to, text),
    onPropActivate: activateProp,
    onSelectionChange: () => onSelectionChange(),
    onSplit: () => splitActiveBlock(),
  });

  /* The slash gesture, at the EDITING HOST.
     `editor/inline-edit.ts` recognised "/" in a `keydown` listener it attached to the BLOCK, and
     for an ordinary block the editing host is this container — so the focused element, and every
     keydown's target, is the container and that listener never fired. Typing "/" in the canvas
     simply inserted a slash: the menu the docs describe, and the shot the manifest quarantined,
     had no trigger at all. It is recognised here, where the keystrokes are, and the engine still
     owns what a slash MEANS (start of a block or after a space; anywhere else it is punctuation).
     The matching `input` half re-filters the open menu, for the same reason: a contenteditable's
     `input` targets its host, not the block the caret happens to be in. */
  const onSlashKey = (e: Event) => handleSlashTrigger(e as KeyboardEvent);
  const onSlashInput = () => {
    if (isSlashActive()) {
      refreshSlashMenu();
    }
  };
  container.addEventListener("keydown", onSlashKey);
  container.addEventListener("input", onSlashInput);
  doc.addEventListener("mouseup", onMouseUp, true);
  doc.addEventListener("keyup", onKeyUp, true);
  doc.addEventListener("blur", onBlurCapture, true);

  const off = channel.onMessage((msg) => {
    if (msg.kind === "applyFormat") {
      applyFormatIntent(msg.intent);
      return;
    }
    if (msg.kind === "openSlash") {
      /* Opened BY NAME, so there is no "/" in the document to anchor it — the engine gives this
         menu its own filter field and deletes nothing when a block is chosen. `openSlashMenu`
         refuses when no caret session is live, which is the same refusal the record's `requires`
         sentence states. */
      openSlashMenu({ anchored: false });
      return;
    }
    if (msg.kind === "flushEdits") {
      // Commit anything the idle tick has not yet written, THEN acknowledge. The commit is posted
      // First, so a parent that has seen the acknowledgement has already applied the text.
      root.flush();
      channel.post({ kind: "flushComplete", reqId: msg.reqId });
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
    if (!editingAllowed()) {
      return;
    }
    // Follow-the-caret after a split or slash-insert: the parent re-renders and then names the path
    // The caret belongs in. Placing the caret is the whole job — activation follows from where the
    // Caret is, so there is nothing else to "enter".
    const el = elementForPath(container, msg.path);
    if (el && isEditableBlock(el)) {
      root.placeCaret({ offset: msg.offset ?? 0, path: msg.path });
    }
  });

  return () => {
    container.removeEventListener("keydown", onSlashKey);
    container.removeEventListener("input", onSlashInput);
    doc.removeEventListener("mouseup", onMouseUp, true);
    doc.removeEventListener("keyup", onKeyUp, true);
    doc.removeEventListener("blur", onBlurCapture, true);
    root.stop();
    off();
    clearHighlight();
    lastNonEmptyRange = null;
    if (isEditing()) {
      stopEditing();
    }
  };
}
