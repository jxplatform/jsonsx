/// <reference lib="dom" />
/**
 * Parent-side iframe canvas host — manages the `<iframe>` that renders a panel's document. It keeps
 * one iframe per canvas element (reused across re-renders), resolves the document parent-side via
 * {@link resolveCanvasDocument}, and posts it over the authenticated channel once the iframe
 * signals `ready`. The parent never reads the iframe's DOM (cross-origin bridge model); it only
 * sends.
 */

import { postMessageChannel } from "./iframe-channel";
import { resolveCanvasDocument } from "./canvas-live-render";
import {
  applyInlineCommit,
  applyInlineInsert,
  applyInlineSplit,
} from "../editor/inline-edit-apply";
import { canvasRectToParent, createOverlayLayer } from "./iframe-overlay";
import { getActivePanel } from "./canvas-helpers";
import { applyDropInstruction } from "../panels/dnd";
import { rectOf } from "../utils/geometry";
import { effect, effectScope } from "../reactivity";
import { pathsEqual } from "../store";
import { activeTab } from "../workspace/workspace";
import type {
  ApplyFormatIntent,
  CanvasMode,
  DragSrcKind,
  IframeToParent,
  NodeHit,
  ParentToIframe,
  SelectionSnapshot,
  SerializedKey,
  WireDocOp,
} from "./iframe-protocol";
import type { IframeChannel } from "./iframe-channel";
import type { OverlayLayer, OverlayPlacement } from "./iframe-overlay";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** A rect in PARENT coordinates (overlay-local from {@link canvasRectToParent}, same field shape). */
type ParentRect = OverlayPlacement;

interface HostState {
  iframe: HTMLIFrameElement;
  channel: IframeChannel<ParentToIframe, IframeToParent>;
  ready: boolean;
  pending: ParentToIframe | null;
  overlay: OverlayLayer;
  /** Document path of the current selection (mirrors `session.selection`), for hover de-dupe. */
  selectionPath: (string | number)[] | null;
  /** Id of the most recent selection `measure` request, so stale `geometry` replies are dropped. */
  selReqId: number;
  /** Whether an inline-edit session is live in this host's iframe (drives the format toolbar). */
  editing: boolean;
  /** The latest selection snapshot from this host's iframe (active tags + caret rect + link). */
  snapshot: SelectionSnapshot | null;
  /** Highest snapshot `seq` seen, so stale (re-ordered) snapshots are dropped. */
  lastSnapshotSeq: number;
  /** The last non-null selection rect drawn (parent/overlay coords) — toolbar position fallback. */
  lastSelectionRect: ParentRect | null;
  /**
   * The gen of the render/patch this iframe's DOM currently reflects (set from `renderComplete`/
   * `patchComplete`). Cross-frame drag replies (`dragOver`/`dropResult`) are dropped unless their
   * `gen` matches, so a drop computed against a superseded render is never applied (Phase 4c).
   */
  lastRenderedGen: number;
}

const hosts = new WeakMap<HTMLElement, HostState>();

/** Every live host, so the selection watcher can re-measure each one when selection changes. */
const liveHosts = new Set<HostState>();

// ─── Cross-frame drag session (Phase 4c) ────────────────────────────────────────
// The parent owns the drag session id and the source data (which never crosses the wire). The
// Coordinator bridge drives the session through the exported API below; the host's dragOver/dropResult
// Handlers stale-gate replies by `currentDragSeq` and the target host's `lastRenderedGen`.

/** Monotonic session id, bumped on each {@link beginDragSession}. Stale replies carry an older seq. */
let currentDragSeq = 0;

/** Parent-retained source data keyed by `dragSeq` (the block fragment never crosses the boundary). */
const retainedSrcData = new Map<number, Record<string, unknown>>();

/** The host backing a given canvas element (or null), for the coordinator's host resolution. */
export function hostForCanvas(canvasEl: HTMLElement): HostState | null {
  return hosts.get(canvasEl) ?? null;
}

/**
 * Resolve the live host whose iframe's parent-viewport rect ({@link rectOf}) contains `cursor`.
 * Used by the coordinator to pick the drop target by pointer position (NOT the active panel), so a
 * drag over any panel's canvas targets that panel. Returns null when the cursor is over no live
 * iframe.
 */
export function liveDragHostAt(cursor: { x: number; y: number }): HostState | null {
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      continue;
    }
    const r = rectOf(host.iframe);
    if (cursor.x >= r.left && cursor.x <= r.right && cursor.y >= r.top && cursor.y <= r.bottom) {
      return host;
    }
  }
  return null;
}

/**
 * Begin a drag session against `host`: bump the session id, retain `srcData` (keyed by the new
 * seq), and post `dragStart` with the source kind and the host's current rendered gen. Returns the
 * seq so the coordinator can tag subsequent move/drop posts.
 */
export function beginDragSession(
  host: HostState,
  src: DragSrcKind,
  srcData: Record<string, unknown>,
): number {
  currentDragSeq += 1;
  retainedSrcData.set(currentDragSeq, srcData);
  host.channel.post({ dragSeq: currentDragSeq, gen: host.lastRenderedGen, kind: "dragStart", src });
  return currentDragSeq;
}

/** The current drag session id, for the coordinator to tag its move/drop posts. */
export function currentDragSession(): number {
  return currentDragSeq;
}

/**
 * The EMPIRICAL zoom scale for `host`'s iframe — `rectOf(iframe).width / iframe.clientWidth` (D-2),
 * read FRESH so a pan/zoom mid-drag is reflected. NOT `effectiveZoom()` (a separate path that can
 * desync). The matching iframe parent-viewport rect is returned so the cursor map cancels the pan.
 */
export function hostDragGeometry(host: HostState): {
  scale: number;
  rect: { left: number; top: number };
} {
  const rect = rectOf(host.iframe);
  const scale = host.iframe.clientWidth > 0 ? rect.width / host.iframe.clientWidth : 1;
  return { rect, scale };
}

/** Post a parent→iframe drag message to `host`'s channel (the coordinator builds it purely). */
export function postDragMessage(host: HostState, msg: ParentToIframe): void {
  if (!host.iframe.isConnected) {
    return;
  }
  host.channel.post(msg);
}

/** Abandon the current session's retained source data (e.g. a drop landed off-canvas). */
export function endDragSession(dragSeq: number): void {
  retainedSrcData.delete(dragSeq);
}

/**
 * The single host whose iframe currently owns the inline-edit session. Only one editable can be
 * active across all panels, so the parent format toolbar reads/writes through this (fixes the
 * multi-panel bug where two hosts' editing state could fight).
 */
let activeEditHost: HostState | null = null;

/** Injected toolbar re-render (set by studio.ts → renderBlockActionBar); avoids a panel→host cycle. */
let toolbarRefresh: (() => void) | null = null;

/** Register the parent toolbar's refresh fn (mirrors {@link setIframePatchEscalation}). */
export function setToolbarRefresh(fn: () => void): void {
  toolbarRefresh = fn;
}

let selectionWatch: { stop: () => void } | null = null;

/** Full-render escalation, injected by studio init (a patchError can't apply surgically). */
let patchEscalation: (() => void) | null = null;

/** Register the full-render fallback the host invokes when the iframe reports a `patchError`. */
export function setIframePatchEscalation(fn: () => void): void {
  patchEscalation = fn;
}

/**
 * Post a surgical patch (value-carrying forward ops) to every ready live iframe host. Returns how
 * many hosts received it; the caller escalates to a full render when that's zero (no host could
 * apply the edit in place, so the suppressed full render must run after all).
 */
export function postPatchToHosts(forwardOps: WireDocOp[], gen: number): number {
  let posted = 0;
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (host.ready) {
      host.channel.post({ forwardOps, gen, kind: "patch" });
      posted += 1;
    }
  }
  return posted;
}

/** Lazily start one reactive watcher that re-measures the selection in every live iframe host. */
function ensureSelectionWatch(): void {
  if (selectionWatch) {
    return;
  }
  const scope = effectScope(true);
  scope.run(() => {
    effect(() => {
      const sel = activeTab.value?.session.selection ?? null;
      for (const host of liveHosts) {
        requestSelection(host, sel);
      }
    });
  });
  selectionWatch = { stop: () => scope.stop() };
}

/** Track the selection on a host and ask its iframe to measure it (or clear the box when null). */
function requestSelection(host: HostState, sel: (string | number)[] | null): void {
  host.selectionPath = sel;
  if (!host.iframe.isConnected) {
    liveHosts.delete(host);
    return;
  }
  if (!sel) {
    host.overlay.setSelection(null);
    return;
  }
  if (!host.ready) {
    return;
  }
  host.selReqId += 1;
  // Post a plain copy: `session.selection` is a reactive proxy, and only serializable values may
  // Cross the postMessage boundary.
  host.channel.post({ kind: "measure", paths: [[...sel]], reqId: host.selReqId });
}

/** The iframe document URL (a static shell that boots the slim canvas bundle). */
const CANVAS_URL = "/packages/studio/canvas.html";

function ensureHost(canvasEl: HTMLElement): HostState {
  const existing = hosts.get(canvasEl);
  if (existing) {
    return existing;
  }
  const { origin } = location;
  const token = crypto.randomUUID();
  const iframe = document.createElement("iframe");
  iframe.className = "jx-canvas-iframe";
  iframe.style.cssText =
    "width:100%;min-height:480px;height:100%;border:0;display:block;background:#fff";
  iframe.src = `${CANVAS_URL}?parentOrigin=${encodeURIComponent(origin)}&token=${token}`;
  // Overlay boxes are positioned within the canvas element, so it must be a positioned ancestor.
  if (!canvasEl.style.position) {
    canvasEl.style.position = "relative";
  }
  const overlay = createOverlayLayer(document);
  canvasEl.replaceChildren(iframe, overlay.root);

  const channel = postMessageChannel<ParentToIframe, IframeToParent>({
    acceptOrigin: origin,
    source: window,
    // Read contentWindow lazily: a freshly-navigated iframe swaps its window, so never capture it.
    target: {
      postMessage: (message, targetOrigin) =>
        iframe.contentWindow?.postMessage(message, targetOrigin),
    },
    targetOrigin: origin,
    token,
  });

  const state: HostState = {
    channel,
    editing: false,
    iframe,
    lastRenderedGen: -1,
    lastSelectionRect: null,
    lastSnapshotSeq: 0,
    overlay,
    pending: null,
    ready: false,
    selectionPath: null,
    selReqId: 0,
    snapshot: null,
  };
  channel.onMessage((msg) => handleMessage(state, msg));
  hosts.set(canvasEl, state);
  liveHosts.add(state);
  ensureSelectionWatch();
  return state;
}

/** Handle a message the iframe posted back: ready handshake, pointer hit/hover, measured geometry. */
function handleMessage(state: HostState, msg: IframeToParent): void {
  switch (msg.kind) {
    case "ready": {
      state.ready = true;
      if (state.pending) {
        state.channel.post(state.pending);
        state.pending = null;
      }
      // Re-measure the current selection now that the iframe can answer.
      requestSelection(state, state.selectionPath);
      return;
    }
    case "hit": {
      // A click in the canvas selects the node; the selection watcher redraws the box via `measure`.
      state.selectionPath = msg.hit.path;
      const tab = activeTab.value;
      if (tab) {
        tab.session.selection = msg.hit.path;
      }
      // Draw immediately from the posted rect for snappiness (the measure round-trip confirms it).
      {
        const rect = canvasRectToParent(msg.hit.rect);
        state.overlay.setSelection(rect);
        state.lastSelectionRect = rect;
      }
      return;
    }
    case "hover": {
      drawHover(state, msg.hit);
      return;
    }
    case "geometry": {
      if (msg.reqId === state.selReqId) {
        const [hit] = msg.hits;
        const rect = hit ? canvasRectToParent(hit.rect) : null;
        state.overlay.setSelection(rect);
        if (rect) {
          state.lastSelectionRect = rect;
        }
      }
      return;
    }
    case "renderComplete":
    case "patchComplete": {
      // The DOM (and so all geometry) just changed — re-measure the selection box. Record the gen
      // The DOM now reflects so cross-frame drag replies can be stale-gated against it (Phase 4c).
      state.lastRenderedGen = msg.gen;
      requestSelection(state, state.selectionPath);
      return;
    }
    case "dragOver": {
      // Display-only drop indicator (Phase 4c). Drop stale replies: a different drag session
      // (dragSeq) or a superseded render (gen). The indicator draw side uses scale=1 (D-2).
      if (msg.dragSeq !== currentDragSeq || msg.gen !== state.lastRenderedGen) {
        return;
      }
      // Indicator drawing lands in a later slice; the preview is plumbed but not drawn yet.
      return;
    }
    case "dropResult": {
      // The authoritative, freshly-computed drop (Phase 4c). Apply through the realm-agnostic
      // Mutation helper with the PARENT-retained source data, unless stale or empty.
      if (msg.dragSeq !== currentDragSeq || msg.gen !== state.lastRenderedGen) {
        return;
      }
      if (msg.instruction && msg.targetPath) {
        const srcData = retainedSrcData.get(msg.dragSeq);
        if (srcData) {
          applyDropInstruction({ type: msg.instruction }, srcData, msg.targetPath);
        }
      }
      retainedSrcData.delete(msg.dragSeq);
      return;
    }
    case "patchError": {
      // The iframe couldn't apply the edit surgically — fall back to a full render of the live doc.
      patchEscalation?.();
      return;
    }
    case "forwardKey": {
      // A global shortcut pressed while the iframe had focus — replay it for the editor's handler.
      redispatchKey(msg.event);
      return;
    }
    case "editStart": {
      // Inline editing began in this host's iframe. Only one editable is active across all panels —
      // Tear down any other host's editing state and make this the single active edit host.
      if (activeEditHost && activeEditHost !== state) {
        activeEditHost.editing = false;
        activeEditHost.snapshot = null;
      }
      activeEditHost = state;
      state.editing = true;
      state.snapshot = null;
      state.lastSnapshotSeq = 0;
      toolbarRefresh?.();
      return;
    }
    case "selectionChanged": {
      // Drop stale (re-ordered) snapshots; otherwise store the latest and refresh the toolbar.
      if (msg.seq <= state.lastSnapshotSeq) {
        return;
      }
      state.lastSnapshotSeq = msg.seq;
      state.snapshot = msg;
      toolbarRefresh?.();
      return;
    }
    case "editCommit": {
      applyInlineCommit(msg.path, msg.children, msg.textContent);
      return;
    }
    case "editSplit": {
      // The split's transactDoc patch was already posted to this host; re-enter on the new paragraph
      // (delivered after the patch, so the element exists by the time the iframe handles it).
      reenterEdit(state, applyInlineSplit(msg.path, msg.before, msg.after));
      return;
    }
    case "editInsert": {
      reenterEdit(state, applyInlineInsert(msg.path, msg.cmd, msg.commitData));
      return;
    }
    case "editEnd": {
      // Ignore a superseded late editEnd (a re-enter's stop→start can deliver a stale one): only act
      // When this host is still the one editing.
      if (!state.editing) {
        return;
      }
      state.editing = false;
      state.snapshot = null;
      if (activeEditHost === state) {
        activeEditHost = null;
      }
      toolbarRefresh?.();
      return;
    }
    default: {
      break;
    }
  }
}

/** Ask the host's iframe to (re-)enter inline editing on `path` (a plain copy crosses the bridge). */
function reenterEdit(state: HostState, path: (string | number)[]): void {
  state.channel.post({ kind: "enterEdit", path: [...path] });
}

/** Rebuild and dispatch a synthetic `keydown` on the editor document from a forwarded keystroke. */
function redispatchKey(event: SerializedKey): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      altKey: event.altKey,
      bubbles: true,
      cancelable: true,
      code: event.code,
      ctrlKey: event.ctrlKey,
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    }),
  );
}

/** Draw the hover box, hidden when there's no hover or it coincides with the current selection. */
function drawHover(state: HostState, hit: NodeHit | null): void {
  if (!hit || pathsEqual(hit.path, state.selectionPath)) {
    state.overlay.setHover(null);
    return;
  }
  state.overlay.setHover(canvasRectToParent(hit.rect));
}

/**
 * Render `doc` into the iframe canvas mounted in `canvasEl`: resolve the document parent-side and
 * post it (queued until the iframe is `ready`).
 */
export async function mountIframeCanvas(
  gen: number,
  doc: JxMutableNode,
  canvasEl: HTMLElement,
): Promise<void> {
  const state = ensureHost(canvasEl);
  // Always resolve and post the latest render. The iframe drops stale generations itself (via its
  // Own `latestGen`), so the parent must NOT gate on `view.renderGeneration`: during boot many
  // Renders fire and the generation is usually stale by the time resolution finishes, which would
  // Otherwise drop every post.
  const resolved = await resolveCanvasDocument(doc);
  // The doc must be structured-cloneable to cross postMessage. A Jx document is JSON by contract, so
  // A JSON round-trip (NOT structuredClone, which would throw) drops residual functions / reactive
  // Proxy artifacts that would otherwise raise DataCloneError and silently drop the entire message.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const cloneableDoc = JSON.parse(JSON.stringify(resolved.renderDoc)) as unknown;
  // The RAW page doc (forward-op + data-jx-path coordinate space) crosses as the iframe's shadow doc.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const cloneableShadow = JSON.parse(JSON.stringify(doc)) as unknown;
  const message: ParentToIframe = {
    doc: cloneableDoc,
    docBase: resolved.docBase ?? `${location.origin}/`,
    gen,
    kind: "render",
    mapperCtx: resolved.mapperCtx,
    mode: resolved.mapperCtx.canvasMode as CanvasMode,
    shadowDoc: cloneableShadow,
    siteStyle: resolved.siteStyle,
  };
  if (state.ready) {
    state.channel.post(message);
  } else {
    state.pending = message;
  }
}

// ─── Format-toolbar bridge (Phase 4b-2) ─────────────────────────────────────────

/** The host whose iframe currently owns the inline-edit session (or null). */
export function getActiveEditHost(): HostState | null {
  return activeEditHost;
}

/** The current edit session's editing flag + latest selection snapshot, for the parent toolbar. */
export function getEditSnapshot(): { editing: boolean; snapshot: SelectionSnapshot | null } {
  if (!activeEditHost) {
    return { editing: false, snapshot: null };
  }
  return { editing: activeEditHost.editing, snapshot: activeEditHost.snapshot };
}

/** Post an `applyFormat` intent to the active edit host's iframe (no-op when none/not ready). */
export function postApplyFormat(intent: ApplyFormatIntent): void {
  const host = activeEditHost;
  if (!host || !host.ready) {
    return;
  }
  host.channel.post({ intent, kind: "applyFormat" });
}

/** The live host backing the active panel's canvas (for non-edit selection-bar positioning). */
function hostForActivePanel(): HostState | null {
  const panel = getActivePanel();
  return panel ? (hosts.get(panel.canvas as HTMLElement) ?? null) : null;
}

/**
 * The format toolbar's anchor rect, in PARENT-VIEWPORT space (the bar is `position:fixed`). The
 * snapshot's rect is in IFRAME-VIEWPORT coords; convert by the same zoom `scale`
 * {@link canvasRectToParent} uses (always 1 in edit mode) and add the iframe's own viewport offset.
 * Falls back to the last selection rect mapped to viewport, else null.
 */
export function getEditBarAnchorRect(): ParentRect | null {
  // The format toolbar follows the live caret/selection snapshot of the active edit session; the
  // Structural bar (tag badge / parent selector / move / convert / drag handle) must still position
  // On a plain selection with no inline-edit session, so fall back to the active panel's host and
  // Its last measured selection rect.
  const editHost = activeEditHost;
  const host = editHost ?? hostForActivePanel();
  if (!host) {
    return null;
  }
  const ifr = rectOf(host.iframe);
  const scale = 1;
  const snapRect = host === editHost ? host.snapshot?.rect : null;
  if (snapRect) {
    return {
      height: snapRect.height * scale,
      left: snapRect.x * scale + ifr.left,
      top: snapRect.y * scale + ifr.top,
      width: snapRect.width * scale,
    };
  }
  if (host.lastSelectionRect) {
    // The fallback rect is overlay-local (same top-left as the iframe) → add the iframe offset.
    return {
      height: host.lastSelectionRect.height,
      left: host.lastSelectionRect.left + ifr.left,
      top: host.lastSelectionRect.top + ifr.top,
      width: host.lastSelectionRect.width,
    };
  }
  return null;
}
