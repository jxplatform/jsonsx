/// <reference lib="dom" />
/**
 * Parent-side iframe canvas host — manages the `<iframe>` that renders a panel's document. It keeps
 * one iframe per canvas element (reused across re-renders), resolves the document parent-side via
 * {@link resolveCanvasDocument}, and posts it over the authenticated channel once the iframe
 * signals `ready`. The parent never reads the iframe's DOM (cross-origin bridge model); it only
 * sends.
 */

import { postMessageChannel } from "./iframe-channel";
import { canvasBaseOrigin } from "./canvas-origin";
import { resolveCanvasDocument } from "./canvas-live-render";
import {
  applyInlineCommit,
  applyInlineInsert,
  applyInlineSplit,
} from "../editor/inline-edit-apply";
import { canvasRectToParent, createOverlayLayer } from "./iframe-overlay";
import { getActivePanel } from "./canvas-helpers";
import { clearDragGhost, moveDragGhost } from "../panels/drag-ghost";
import { applyDropInstruction } from "../panels/dnd";
import { rectOf } from "../utils/geometry";
import { effect, effectScope } from "../reactivity";
import { canvasWrap, pathsEqual } from "../store";
import { activeTab } from "../workspace/workspace";
import { getPlatform, hasPlatform } from "../platform";
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
  /**
   * The resolved canvasUrl this iframe was built with — so a host built early with the default URL
   * is rebuilt once the platform's loopback canvasUrl becomes available (electrobun resolves it
   * async).
   */
  canvasUrl: string;
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

/**
 * Opaque drag-target host handle for the coordinator bridge. The bridge passes it back to the
 * session API ({@link beginDragSession}/{@link hostDragGeometry}/{@link postDragMessage}) without
 * reading its fields.
 */
export type DragHost = HostState;

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

/**
 * Adopt an IFRAME-DRIVEN (flow 3) drag session: the iframe already owns the pointer it started and
 * drives the whole gesture, so the parent does NOT post a `dragStart` — it only sets the
 * authoritative `currentDragSeq` to the iframe's seq and retains the (path-only) source data keyed
 * by it, so the iframe's `dragOver`/`dropResult` (which carry that same seq) pass the parent's seq
 * gate and the drop applies with the retained source. Returns the adopted seq.
 */
export function adoptDragSession(
  _host: HostState,
  _src: DragSrcKind,
  srcData: Record<string, unknown>,
  seq: number,
): number {
  currentDragSeq = seq;
  retainedSrcData.set(seq, srcData);
  return seq;
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

/** Hide `host`'s drop indicator (the coordinator's timeout fallback when no dropResult arrives). */
export function clearDropIndicator(host: HostState): void {
  host.overlay.setDropIndicator(null);
}

/**
 * The coordinator's handler for an iframe-originated (flow 3) drag. Installed by the bridge to
 * avoid a host→bridge import cycle; invoked from the `dragOriginate` message case with the host,
 * the grabbed node path, AND the iframe's pre-allocated dragSeq. The iframe DRIVES the gesture
 * itself (its held-button moves stay in the iframe document), so the coordinator only ADOPTS this
 * seq (no dragStart, no parent-document listeners) and shows the ghost — the iframe's
 * dragOver/dropResult carry the same seq and so pass the parent's seq gate.
 */
let iframeOriginateHandler:
  | ((host: HostState, path: (string | number)[], dragSeq: number) => void)
  | null = null;

/** Register the coordinator's iframe-originated-drag handler (see {@link iframeOriginateHandler}). */
export function setIframeOriginateHandler(
  fn: (host: HostState, path: (string | number)[], dragSeq: number) => void,
): void {
  iframeOriginateHandler = fn;
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

/**
 * The default iframe document URL (a static shell that boots the slim canvas bundle). Used when the
 * platform does not provide its own canvasUrl — i.e. the dev server and electrobun keep this path.
 */
const DEFAULT_CANVAS_URL = "/packages/studio/canvas.html";

function ensureHost(canvasEl: HTMLElement): HostState {
  // Read the platform's canvasUrl when one is registered; otherwise fall back to the default. The
  // Dev server leaves it unset, and some tests mount without a platform registered.
  const canvasUrl = (hasPlatform() ? getPlatform().canvasUrl : undefined) ?? DEFAULT_CANVAS_URL;
  const existing = hosts.get(canvasEl);
  if (existing) {
    if (existing.canvasUrl === canvasUrl) {
      return existing;
    }
    // The platform's loopback canvasUrl arrived after this host was built with the default URL
    // (electrobun resolves it async over RPC) — tear the early iframe down and rebuild against the
    // Right cross-origin origin.
    existing.channel.dispose();
    liveHosts.delete(existing);
    hosts.delete(canvasEl);
  }
  // ParentOrigin is the parent's real origin, passed into the iframe URL so the cross-origin iframe
  // Can target a postMessage back at it.
  const parentOrigin = location.origin;
  const token = crypto.randomUUID();
  // IframeOrigin is the iframe's own origin. For a RELATIVE canvasUrl (dev / chromium) it resolves to
  // The parent's location.origin (same-origin). For an absolute loopback canvasUrl (electrobun) it is
  // The loopback origin, so the channel accepts/targets the right cross-origin peer.
  const iframeOrigin = new URL(canvasUrl, location.href).origin;
  const iframe = document.createElement("iframe");
  iframe.className = "jx-canvas-iframe";
  iframe.style.cssText =
    "width:100%;min-height:480px;height:100%;border:0;display:block;background:#fff";
  // Preserve any query already on canvasUrl (e.g. electrobun's ?win=7) and append the token (always)
  // Plus parentOrigin (conditionally — see below).
  const srcUrl = new URL(canvasUrl, location.href);
  srcUrl.searchParams.set("token", token);
  // Pass parentOrigin into the iframe src ONLY when the PARENT is served over http(s) (dev / chromium
  // — same-origin, so the origin round-trips and the iframe can keep its acceptOrigin STRICT). For a
  // Non-http(s) parent (electrobun views://) OMIT it: a custom scheme may not surface as a postMessage
  // Origin (event.origin), so the iframe falls back to acceptOrigin '*' + the shared token (it logs
  // The warn) rather than silently stalling. The PARENT side here stays STRICT — acceptOrigin /
  // TargetOrigin are the real (loopback) iframeOrigin below, a gateable origin.
  if (location.protocol === "http:" || location.protocol === "https:") {
    srcUrl.searchParams.set("parentOrigin", parentOrigin);
  }
  // Keep a relative canvasUrl relative in the src attribute (emit only path+query, not the resolved
  // Absolute URL) so the same-origin path stays byte-identical.
  iframe.src = iframeOrigin === parentOrigin ? `${srcUrl.pathname}${srcUrl.search}` : srcUrl.href;
  // Overlay boxes are positioned within the canvas element, so it must be a positioned ancestor.
  if (!canvasEl.style.position) {
    canvasEl.style.position = "relative";
  }
  const overlay = createOverlayLayer(document);
  canvasEl.replaceChildren(iframe, overlay.root);
  // Neutralize the legacy hit-test catcher. `.canvas-panel-click` is an absolutely-positioned sibling
  // (z-index:9, inset:0) with the default `pointer-events:auto`, so it sits OVER this canvas and would
  // Eat every click/wheel before the iframe — which now owns hit-testing AND native scrolling — can
  // See them. Stylebook still relies on it, but its panels render a div canvas and never mount an iframe
  // Host, so scoping the neutralization to this mount leaves stylebook untouched.
  const catcher = canvasEl.parentElement?.querySelector<HTMLElement>(".canvas-panel-click");
  if (catcher) {
    catcher.style.pointerEvents = "none";
  }

  const channel = postMessageChannel<ParentToIframe, IframeToParent>({
    acceptOrigin: iframeOrigin,
    source: window,
    // Read contentWindow lazily: a freshly-navigated iframe swaps its window, so never capture it.
    target: {
      postMessage: (message, targetOrigin) =>
        iframe.contentWindow?.postMessage(message, targetOrigin),
    },
    targetOrigin: iframeOrigin,
    token,
  });

  const state: HostState = {
    canvasUrl,
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
    case "contentHeight": {
      // Size the iframe element to its document so the canvas never scrolls internally — the parent
      // Canvas pans/scrolls instead, every node stays inside the iframe box (hit-testable), and the
      // Overlay (drawn in canvas space) tracks it. `min-height` in cssText floors short documents.
      state.iframe.style.height = `${msg.height}px`;
      return;
    }
    case "dragOver": {
      // Display-only drop indicator (Phase 4c). Drop stale replies: a different drag session
      // (dragSeq) or a superseded render (gen). The indicator draw side uses scale=1 (D-2) — the
      // Overlay is inside the scaled panzoom-wrap, so the browser already applies the zoom.
      if (msg.dragSeq !== currentDragSeq || msg.gen !== state.lastRenderedGen) {
        return;
      }
      if (msg.preview) {
        state.overlay.setDropIndicator(
          canvasRectToParent(msg.preview.referenceRect),
          msg.preview.edge,
        );
      } else {
        state.overlay.setDropIndicator(null);
      }
      // Flow 3 (iframe-driven) posts a `cursor` in iframe-viewport coords: the parent has no pointer
      // Of its own during an iframe-originated drag, so position the ghost by FORWARD-converting the
      // Cursor to parent-viewport space (the inverse of parentCursorToIframe). Parent-driven flows
      // (1/2/4) omit `cursor` — the bridge moves their ghost from the raw parent pointer.
      if (msg.cursor) {
        const g = hostDragGeometry(state);
        moveDragGhost(msg.cursor.x * g.scale + g.rect.left, msg.cursor.y * g.scale + g.rect.top);
      }
      return;
    }
    case "dragOriginate": {
      // Flow 3: the iframe began a body-grab drag and DRIVES it locally. Hand off to the coordinator,
      // Which ADOPTS the iframe's seq (so its dragOver/dropResult pass the gate) and shows the ghost
      // — it attaches NO parent-document listeners (the iframe owns the pointer it started).
      iframeOriginateHandler?.(state, msg.path, msg.dragSeq);
      return;
    }
    case "dragEnd": {
      // The iframe cancelled a flow-3 drag locally (Escape). Tear down the indicator/ghost and
      // Release the retained source data so no drop is applied.
      state.overlay.setDropIndicator(null);
      clearDragGhost();
      retainedSrcData.delete(msg.dragSeq);
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
      // The drop resolved (or was empty) — tear down the display affordances on this host.
      state.overlay.setDropIndicator(null);
      clearDragGhost();
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
    case "forwardWheel": {
      // A wheel over the iframe — replay it on canvasWrap so the editor's zoom/pan handler fires (the
      // Cursor is mapped from iframe-viewport coords to parent-viewport via this host's scale + offset).
      redispatchWheel(state, msg);
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

/**
 * Replay a forwarded wheel on `canvasWrap` so the editor's zoom/pan handler fires. The forwarded
 * cursor is in iframe-viewport CSS px; map it to parent-viewport space by the host's empirical zoom
 * scale ({@link hostDragGeometry}) plus the iframe's on-screen offset, so ctrl+wheel zooms toward
 * the real cursor. A synthetic event triggers no native scroll, which is fine — the handler does
 * the work.
 */
function redispatchWheel(
  state: HostState,
  msg: Extract<IframeToParent, { kind: "forwardWheel" }>,
): void {
  const { rect, scale } = hostDragGeometry(state);
  canvasWrap.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + msg.x * scale,
      clientY: rect.top + msg.y * scale,
      ctrlKey: msg.ctrlKey,
      deltaX: msg.deltaX,
      deltaY: msg.deltaY,
      metaKey: msg.metaKey,
      shiftKey: msg.shiftKey,
    }),
  );
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
 *
 * `widthPx` makes the panel's breakpoint width an EXPLICIT lever on the iframe element itself (only
 * `style.width` is touched — the rest of cssText, incl. `min-height:480px; height:100%`, is kept).
 * The iframe is a real viewport, so its CSS width is the layout viewport `@media` evaluates
 * against; setting it here survives iframe reuse and any future container-styling change. Null
 * (edit-mode / git-diff / full-width panels) falls back to `100%`. The iframe stays FIXED-HEIGHT —
 * content scrolls inside it like a real device viewport; narrowing the width does not auto-grow
 * it.
 */
export async function mountIframeCanvas(
  gen: number,
  doc: JxMutableNode,
  canvasEl: HTMLElement,
  widthPx?: number | null,
): Promise<void> {
  const state = ensureHost(canvasEl);
  state.iframe.style.width = widthPx ? `${widthPx}px` : "100%";
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
    docBase: resolved.docBase ?? `${canvasBaseOrigin()}/`,
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
