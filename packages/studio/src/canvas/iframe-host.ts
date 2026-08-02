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
import { getPreviewNavigateHandler } from "./preview-navigate";
import { resolveCanvasDocument } from "./canvas-live-render";
import {
  applyBlockMerge,
  applyInlineCommit,
  applyRangeReplace,
  applyInlinePropCommit,
  applyInlineInsert,
  applyInlineSplit,
} from "../editor/inline-edit-apply";
import { canvasRectToParent, createOverlayLayer } from "./iframe-overlay";
import { serializeJxPath } from "./path-mapping";
import { getActivePanel, panelMediaToActiveMedia } from "./canvas-helpers";
import { panToParentRect } from "./canvas-utils";
import { clearDragGhost, moveDragGhost } from "../panels/drag-ghost";
import { applyDropInstruction } from "../panels/dnd";
import { rectOf } from "../utils/geometry";
import { effect, effectScope } from "../reactivity";
import {
  canvasPanels,
  canvasWrap,
  pathsEqual,
  projectState,
  renderOnly,
  updateCanvas,
  updateUi,
} from "../store";
import { activeTab, workspace } from "../workspace/workspace";
import { setLayoutSelection, shell } from "../shell";
import { formatEditableVerdicts } from "../format/constraints";
import { formatByName } from "../format/format-host";
import { collabState } from "../collab/collab-state";
import { getPlatform, hasPlatform } from "../platform";
import type {
  ApplyFormatIntent,
  CanvasMode,
  DragSrcKind,
  DropPreview,
  EvalExprResult,
  FileDropHit,
  IframeToParent,
  InsertZone,
  NodeHit,
  ParentToIframe,
  SelectionSnapshot,
  SerializedKey,
  WireDocOp,
} from "./iframe-protocol";
import type { IframeChannel } from "./iframe-channel";
import type { OverlayLayer, OverlayPlacement } from "./iframe-overlay";
import type { SlashCommand } from "../editor/inline-edit";
import type { Tab } from "../tabs/tab";
import type { JxExpressionNode, JxMutableNode } from "@jxsuite/schema/types";

/** A rect in PARENT coordinates (overlay-local from {@link canvasRectToParent}, same field shape). */
type ParentRect = OverlayPlacement;

interface HostState {
  iframe: HTMLIFrameElement;
  /** The `.canvas-panel-canvas` element hosting the iframe + overlay (the WeakMap key). */
  canvasEl: HTMLElement;
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
  /** Id of the most recent presence `measure` request (allocated from the selReqId counter). */
  presenceReqId: number;
  /** Serialized peer path → presence box meta for the in-flight presence measure. */
  presenceMeta: Map<string, { color: string; label: string }>;
  /**
   * Whether this host's iframe currently renders a PREVIEW. Preview is the fidelity view, so the
   * host refuses every editing message from it ({@link PREVIEW_BLOCKED}), suppresses the overlay
   * layer, and leaves the iframe at its CSS height so the frame scrolls its own document.
   */
  preview: boolean;
  /** Whether an inline-edit session is live in this host's iframe (drives the format toolbar). */
  editing: boolean;
  /** The prop a live plain session edits (prop-bound text) — null for rich sessions/none. */
  editingProp: string | null;
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
  /**
   * The insertion "+" zone the overlay button currently anchors to (the iframe posts it on hover);
   * captured here so the button's click handler runs the slash-menu → mutateInsertNode flow against
   * the same parentPath/index. Null when no "+" is shown.
   */
  insertZone: InsertZone | null;
  /**
   * Grace timer (SALVAGED HIDE_DELAY) so a `null` zone post (cursor crossed mid-element on its way
   * to the button) doesn't yank the "+" before the author reaches it; cancelled on re-show / button
   * mouseenter. Null when not pending.
   */
  insertHideTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Whether the cursor is currently ON the "+" (button mouseenter → true, mouseleave → false).
   *
   * The parent MUST hold this itself: the iframe cannot see the cursor once it lands on the button
   * (a parent-realm element overlaying the iframe), so it reports a full pointer-leave and posts
   * `insertZones: null` — which crosses the bridge ASYNCHRONOUSLY and therefore lands just AFTER
   * the button's own synchronous `mouseenter` cancelled the grace timer. Re-arming would then hide
   * the "+" ~300ms into the author's click, which is the whole flighty-affordance bug. The hide
   * checks this at FIRE time, so the ordering of the two signals no longer matters.
   */
  insertHover: boolean;
  /**
   * Id of the tab whose document this host's iframe DOM currently reflects. Adopted from
   * {@link HostState.pendingTabIds} ONLY when the render acks (`renderComplete`), so on the FIFO
   * channel any edit-session commit the iframe posts ahead of that ack still routes to the tab the
   * session belonged to. Doc-mutating bridge messages (editCommit/editSplit/editInsert/dropResult)
   * resolve their target tab from THIS — never from `activeTab` at message time, which may have
   * changed while the message was in flight (the cross-document bleed).
   */
  tabId: string | null;
  /** Tab id keyed by render gen for posted-but-unacked renders; adopted on `renderComplete`. */
  pendingTabIds: Map<number, string | null>;
  /**
   * A split/insert re-entry deferred until this host's DOM contains the new element: a surgical
   * patch acks (`patchComplete`) at the SAME gen the host already reflects, an escalated full
   * render acks (`renderComplete`) at a bumped one — both satisfy `gen >= minGen`. An immediate
   * `enterEdit` would race the escalated ASYNC render and silently fail to find the element.
   */
  pendingEnterEdit: { path: (string | number)[]; minGen: number; offset?: number } | null;
  /**
   * Stylebook capability (set by {@link mountStylebookCanvas}, cleared by page mounts). The specimen
   * doc's paths decode to TAGS, not tab-document paths: hits route to the injected stylebook
   * handler instead of `session.selection`, the selection watcher measures the selected tag's card,
   * and the document-editing affordances (insert "+", context menu, grab-drags) are ignored for
   * this host.
   */
  stylebook: {
    pathToTag: ReadonlyMap<string, string>;
    tagToCardPath: ReadonlyMap<string, (string | number)[]>;
  } | null;
  /** Measure-request id of an in-flight pan-to-card (stylebook); -1 when none. */
  panReqId: number;
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

/**
 * The last session whose cursor-carrying `dragOver` arrived FROM an iframe, and when. While a
 * parent-originated drag is over the canvas, the native dragover/drop stream is delivered to the
 * IFRAME (not the parent), so the iframe drives the session's dragOvers and its native drop posts
 * the dropResult. The coordinator checks {@link sawIframeDragOver} in its `onDrop` to know the
 * parent's own drop location is frame-local garbage and the in-flight dropResult is authoritative.
 */
let lastIframeDragOverSeq = -1;
let lastIframeDragOverAt = 0;

/**
 * How recently (ms) an iframe-driven dragOver still marks the iframe as owning the stream. Native
 * dragover re-fires ~350ms even with a stationary cursor, so an iframe the cursor is still over
 * stays fresh; once the cursor moves back to parent chrome (e.g. drops on the block-action-bar,
 * which overlays the iframe) the iframe stream stops and the parent's drop coords are trusted
 * again.
 */
const IFRAME_DRAGOVER_FRESH_MS = 600;

/** Whether the iframe recently drove a `dragOver` for session `seq` (see above). */
export function sawIframeDragOver(seq: number): boolean {
  return (
    lastIframeDragOverSeq === seq && Date.now() - lastIframeDragOverAt <= IFRAME_DRAGOVER_FRESH_MS
  );
}

// ─── Live expression preview (M6) ───────────────────────────────────────────────
// The parent asks a live iframe to evaluate expression nodes against its LIVE resolved scope and
// Correlates the `evalResult` reply by reqId (the measure/geometry precedent), gen-gating it so a
// Reply computed against a superseded render never paints badges.

/** Monotonic eval request id (shared across hosts; stale replies carry an older/unknown id). */
let evalReqId = 0;

/**
 * One-shot: let automatic `$prototype: "Request"` entries fetch on the NEXT page render even in
 * edit/design mode.
 *
 * Those fetches are suppressed outside preview because a full render re-resolves every state entry,
 * so an escalating authoring action would issue a request per render. But the Data activity's
 * Refresh exists to re-fire them on demand — its documented purpose — so it arms this flag and the
 * next render consumes it. Deliberately one-shot: a subsequent escalation must not inherit it.
 */
let _allowAutoRequestsOnce = false;

/**
 * Open a preview link's target for real.
 *
 * Resolved against the CANVAS's origin, not the editor's: the canvas iframe is served from the
 * project's own origin so relative `src`/`href` resolve the way they will in production, and the
 * editor shell may sit on a different origin entirely (a deep `/edit/:owner/:repo` path in the
 * cloud). Resolving against `location` would send a root-relative `/about` to the wrong host.
 */
function openPreviewHref(href: string, state: HostState): void {
  let resolved: URL;
  try {
    resolved = new URL(href, state.iframe.src || canvasBaseOrigin());
  } catch {
    return; // Unparseable even against a base — nothing sensible to open.
  }
  /*
   * Scheme allowlist. A page can carry any href, and handing `javascript:` or `data:` to
   * `window.open` would execute it — in the EDITOR's origin, since the shell is the opener. Web pages
   * and the contact affordances real sites use are all that Preview needs to follow.
   */
  if (!["http:", "https:", "mailto:", "tel:"].includes(resolved.protocol)) {
    return;
  }
  const url = resolved.href;
  const override = getPreviewNavigateHandler();
  if (override) {
    override(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Arm the next page render to allow automatic request fetches (Data activity Refresh). */
export function allowAutoRequestsOnNextRender(): void {
  _allowAutoRequestsOnce = true;
}

function consumeAllowAutoRequests(): boolean {
  const armed = _allowAutoRequestsOnce;
  _allowAutoRequestsOnce = false;
  return armed;
}

/** Pending eval resolvers keyed by reqId; a timeout or stale reply resolves null. */
const pendingEvals = new Map<number, (results: EvalExprResult[] | null) => void>();

/** How long (ms) the parent waits for an `evalResult` before falling back to the snapshot. */
export const EVAL_TIMEOUT_MS = 300;

/**
 * Post an `evalExpr` request to the live, ready iframe host rendering `tabId`'s document and
 * resolve with its results. Resolves `null` when no such host exists (caller falls back to the
 * snapshot evaluator immediately), when no reply lands within `timeoutMs`, or when the reply's gen
 * shows it was computed against a superseded render.
 */
export function requestCanvasEval(
  tabId: string | null,
  exprs: { id: string; node: unknown }[],
  contextPath: (string | number)[] | null,
  timeoutMs: number = EVAL_TIMEOUT_MS,
): Promise<EvalExprResult[] | null> {
  let target: HostState | null = null;
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    // Only a document host can answer (never a stylebook specimen catalog or a null-tab override
    // Doc like git-diff), and only the one whose iframe DOM reflects this tab's document.
    if (host.ready && !host.stylebook && tabId !== null && host.tabId === tabId) {
      target = host;
      break;
    }
  }
  if (!target) {
    return Promise.resolve(null);
  }
  evalReqId += 1;
  const reqId = evalReqId;
  // Expression nodes come off the reactive document — only plain values may cross postMessage.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const wireExprs = JSON.parse(JSON.stringify(exprs)) as { id: string; node: JxExpressionNode }[];
  target.channel.post({
    contextPath: contextPath ? [...contextPath] : null,
    exprs: wireExprs,
    gen: target.lastRenderedGen,
    kind: "evalExpr",
    reqId,
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingEvals.delete(reqId);
      resolve(null);
    }, timeoutMs);
    pendingEvals.set(reqId, (results) => {
      clearTimeout(timer);
      resolve(results);
    });
  });
}

// ─── Pending-edit flush ─────────────────────────────────────────────────────────
// Text reaches the document on an idle tick, so anything that reads the document as authoritative
// Must first ask every live frame to commit what the caret has typed since. Without this, saving
// Mid-sentence writes the file WITHOUT the words still sitting in the caret's block.

/** Monotonic flush request id. */
let flushReqId = 0;

/** Pending flush resolvers keyed by reqId; a timeout resolves anyway rather than blocking a save. */
const pendingFlushes = new Map<number, () => void>();

/** How long (ms) the parent waits for a frame to acknowledge a flush before saving regardless. */
export const FLUSH_TIMEOUT_MS = 250;

/**
 * Ask every live frame rendering `tabId` to commit its pending text, and resolve once they have all
 * acknowledged (or the timeout elapses — a save must never hang on an unresponsive frame).
 */
export function flushCanvasEdits(
  tabId: string | null,
  timeoutMs: number = FLUSH_TIMEOUT_MS,
): Promise<void> {
  const targets: HostState[] = [];
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (host.ready && !host.stylebook && tabId !== null && host.tabId === tabId) {
      targets.push(host);
    }
  }
  if (targets.length === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let outstanding = targets.length;
    const timer = setTimeout(() => {
      for (const id of ids) {
        pendingFlushes.delete(id);
      }
      resolve();
    }, timeoutMs);
    const settle = () => {
      outstanding -= 1;
      if (outstanding === 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    const ids: number[] = [];
    for (const host of targets) {
      flushReqId += 1;
      const reqId = flushReqId;
      ids.push(reqId);
      pendingFlushes.set(reqId, settle);
      host.channel.post({ kind: "flushEdits", reqId });
    }
  });
}

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
  // The src crosses postMessage: plain-copy the path so a reactive-proxy array (e.g. a live
  // Selection fed through a drag source) can't DataCloneError the structured clone. Test fake
  // Channels pass messages by reference and never exercise the clone, so guard at the boundary.
  const wireSrc: DragSrcKind =
    src.type === "tree-node" ? { path: [...src.path], type: "tree-node" } : { type: src.type };
  host.channel.post({
    dragSeq: currentDragSeq,
    gen: host.lastRenderedGen,
    kind: "dragStart",
    src: wireSrc,
  });
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

/**
 * Pin the `.canvas-panel-viewport` (the white "page" surface, the canvas element's parent) to the
 * SCALED content height when edit-mode content zoom is active. A `transform: scale()` on the canvas
 * element rescales its painted box but never its ancestor's auto-height, so without this write the
 * viewport background would stay sized to the UN-zoomed iframe height. The scale is read from the
 * canvas element's own inline transform (written only by `applyEditZoom`) — NOT from
 * {@link hostDragGeometry}, whose empirical ratio also reflects design mode's panzoom-wrap
 * transform, where the viewport must keep its unscaled auto height.
 */
function syncEditZoomViewportHeight(state: HostState): void {
  const viewport = state.canvasEl.parentElement;
  if (!viewport) {
    return;
  }
  const match = /scale\(([\d.]+)\)/.exec(state.canvasEl.style.transform);
  const scale = match ? Number(match[1]!) : 1;
  viewport.style.height = scale === 1 ? "" : `${state.iframe.offsetHeight * scale}px`;
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
 * The coordinator's handler for a NATIVE drag stream entering an iframe with no session bound there
 * (the `nativeDragEnter` message) — the bridge binds/migrates its live pragmatic session to that
 * host. Installed by the bridge to avoid a host→bridge import cycle.
 */
let nativeDragEnterHandler: ((host: HostState) => void) | null = null;

/** Register the coordinator's native-drag-enter handler (see {@link nativeDragEnterHandler}). */
export function setNativeDragEnterHandler(fn: (host: HostState) => void): void {
  nativeDragEnterHandler = fn;
}

/** Delay (ms) before hiding the insertion "+" so the cursor can reach it (SALVAGED HIDE_DELAY). */
export const INSERT_HIDE_DELAY = 300;

/**
 * The parent-realm insertion handler: open the slash menu anchored at the "+" `btn` and, on select,
 * run `transactDoc → mutateInsertNode` for the captured `zone`. Injected from studio.ts (which owns
 * the slash-menu / transact / defaultDef wiring) so this host module — and its tests — stay free of
 * the lit/Spectrum slash-menu and the mutation pipeline, mirroring the native-drag handler.
 */
let insertZoneClickHandler: ((btn: HTMLElement, zone: InsertZone) => void) | null = null;

/** Register the slash-menu → mutateInsertNode handler the insertion "+" runs on click. */
export function setInsertZoneClickHandler(fn: (btn: HTMLElement, zone: InsertZone) => void): void {
  insertZoneClickHandler = fn;
}

/**
 * The parent-realm handler for an external file drop on a canvas (flow 5): upload the files and
 * either replace an existing image's source or insert new elements. Injected from studio.ts for the
 * same reason as {@link insertZoneClickHandler} — it reaches the platform and the mutation pipeline,
 * which this module and its tests stay free of.
 */
let fileDropHandler:
  | ((
      tab: Tab | null,
      files: File[],
      hit: FileDropHit | null,
      preview: DropPreview | null,
    ) => void | Promise<void>)
  | null = null;

/** Register the upload → replace-or-insert handler for external file drops (see flow 5). */
export function setFileDropHandler(
  fn: (
    tab: Tab | null,
    files: File[],
    hit: FileDropHit | null,
    preview: DropPreview | null,
  ) => void | Promise<void>,
): void {
  fileDropHandler = fn;
}

/**
 * Draw the affordance for a file drag hovering `state`'s canvas: a solid highlight over the image
 * the drop would REPLACE, or the usual insert indicator. Exactly one shows at a time — they answer
 * different questions, and both at once would be ambiguous.
 */
function showFileDropAffordance(
  state: HostState,
  hit: FileDropHit | null,
  preview: DropPreview | null,
): void {
  const replacing = hit ? isReplaceableTag(hit.tagName) : false;
  if (replacing && hit) {
    state.overlay.setDropIndicator(null);
    state.overlay.setReplaceTarget(canvasRectToParent(hit.rect));
    return;
  }
  state.overlay.setReplaceTarget(null);
  state.overlay.setDropIndicator(
    preview ? canvasRectToParent(preview.referenceRect) : null,
    preview?.edge,
  );
}

/** Hide both file-drop affordances on `state`. */
function clearFileDropAffordance(state: HostState): void {
  state.overlay.setReplaceTarget(null);
  state.overlay.setDropIndicator(null);
}

/**
 * Whether a drop on this tag would replace a picture rather than insert beside it. Kept in sync
 * with `REPLACE_ATTRS` in editor/file-drop-action.ts, which owns the authoritative decision — this
 * is the display-only preview, so a custom element (whose verdict needs the component registry) is
 * shown as an insert and may still resolve to a replace on drop.
 */
function isReplaceableTag(tagName: string): boolean {
  return tagName === "img" || tagName === "video" || tagName === "source";
}

/**
 * Accept file drops on the canvas element itself — the margin around the iframe box. The iframe
 * swallows everything over the rendered page (Chromium routes native drags to the frame under the
 * cursor), so this only ever sees a drop on the surrounding gutter, which appends to the document
 * root. Attached once per canvas element; the guard makes a re-mount idempotent.
 */
function registerCanvasGutterDrop(canvasEl: HTMLElement, host: () => HostState | null): void {
  if (canvasEl.dataset.jxGutterDrop === "1") {
    return;
  }
  canvasEl.dataset.jxGutterDrop = "1";
  canvasEl.addEventListener("dragover", (e: DragEvent) => {
    if (![...(e.dataTransfer?.types ?? [])].includes("Files")) {
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
  });
  canvasEl.addEventListener("drop", (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    const state = host();
    if (!files?.length || !state || state.stylebook) {
      return;
    }
    e.preventDefault();
    void fileDropHandler?.(hostTab(state), [...files], null, null);
  });
}

/** A canvas-originated slash-menu request, converted to PARENT-VIEWPORT coords by the host. */
export interface CanvasSlashRequest {
  rect: { left: number; top: number; bottom: number; width: number; height: number };
  filter: string;
  onSelect: (cmd: SlashCommand) => void;
  onDismiss: () => void;
}

/**
 * The parent-realm slash-menu surface the canvas iframe drives (show at a rect, navigate by key,
 * dismiss). Injected from studio.ts (which owns the lit/Spectrum menu) so this host module — and
 * its tests — stay free of it, mirroring {@link insertZoneClickHandler}.
 */
export interface CanvasSlashHandler {
  show: (req: CanvasSlashRequest) => void;
  nav: (key: string) => void;
  dismiss: () => void;
}

let canvasSlashHandler: CanvasSlashHandler | null = null;

/** Register the parent-realm slash-menu surface the canvas iframe drives. */
export function setCanvasSlashHandler(handler: CanvasSlashHandler): void {
  canvasSlashHandler = handler;
}

/**
 * The parent-realm context-menu surface for canvas right-clicks (show at parent-viewport coords,
 * dismiss on a canvas left-click). Injected from studio.ts, same DI pattern as the slash handler.
 */
export interface CanvasContextMenuHandler {
  show: (args: { path: (string | number)[] | null; clientX: number; clientY: number }) => void;
  dismiss: () => void;
}

let canvasContextMenuHandler: CanvasContextMenuHandler | null = null;

/** Register the parent-realm context-menu surface the canvas iframe drives. */
export function setCanvasContextMenuHandler(handler: CanvasContextMenuHandler): void {
  canvasContextMenuHandler = handler;
}

/**
 * The parent-realm stylebook selection handler: a hit in a stylebook host decodes to a TAG (or null
 * for chrome/empty space) plus the clicked panel's media, and routes here — never to
 * `session.selection`. Injected from studio.ts (which owns selectStylebookTag), same DI pattern as
 * the slash/context handlers.
 */
let stylebookHitHandler: ((tag: string | null, media: string | null) => void) | null = null;

/** Register the stylebook tag-selection handler stylebook hosts route hits to. */
export function setStylebookHitHandler(
  fn: (tag: string | null, media: string | null) => void,
): void {
  stylebookHitHandler = fn;
}

/**
 * Decode a stylebook hit path to its tag/compound: exact `pathToTag` lookup, then trim trailing
 * path segments pairwise ("children", i) so a hit on an unmapped descendant resolves to its nearest
 * mapped ancestor. Null = chrome/empty space (deselect).
 */
function resolveStylebookTag(
  pathToTag: ReadonlyMap<string, string>,
  path: (string | number)[],
): string | null {
  let p = [...path];
  for (;;) {
    const tag = pathToTag.get(serializeJxPath(p));
    if (tag) {
      return tag;
    }
    if (p.length < 2) {
      return null;
    }
    p = p.slice(0, -2);
  }
}

/**
 * The single host whose iframe currently owns the inline-edit session. Only one editable can be
 * active across all panels, so the parent format toolbar reads/writes through this (fixes the
 * multi-panel bug where two hosts' editing state could fight).
 */
let activeEditHost: HostState | null = null;

/**
 * Whether a text caret is live in a canvas iframe — the parent realm's only honest answer to "is
 * the author typing right now".
 *
 * The editing session runs INSIDE the cross-origin canvas frame, so `editor/inline-edit.ts`'s
 * `isEditing()` — a module-local `activeEl` in the PARENT bundle — is permanently false here. The
 * bridge already carries the truth: `editStart` opens a session, `selectionChanged` proves the
 * caret is still live in it, `editEnd` closes it. Derived rather than stored per host, so a frame
 * torn down mid-session (a mode switch, a closed tab) can never latch the flag on and go on
 * stealing ⌘C from a caret that no longer exists.
 */
export function isCaretActive(): boolean {
  const host = activeEditHost;
  return Boolean(host?.editing && host.iframe.isConnected);
}

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
 * Post a surgical patch (value-carrying forward ops) to every ready live iframe host rendering
 * `tabId`'s document — a still-connected host showing another tab's doc must never fold a foreign
 * edit into its shadow doc. Returns how many hosts received it; the caller escalates to a full
 * render when that's zero (no host could apply the edit in place, so the suppressed full render
 * must run after all).
 */
export function postPatchToHosts(
  forwardOps: WireDocOp[],
  gen: number,
  tabId: string | null,
): number {
  let posted = 0;
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (host.ready && host.tabId === tabId) {
      // Only the host that originated this edit already has the DOM the patch describes. A
      // Split-view panel on the same document did NOT type it and must render normally.
      const echoPaths = echoOrigin?.host === host ? echoOrigin.paths : undefined;
      host.channel.post(
        echoPaths
          ? { echoPaths, forwardOps, gen, kind: "patch" }
          : { forwardOps, gen, kind: "patch" },
      );
      posted += 1;
    }
  }
  return posted;
}

/**
 * The host whose own in-place commit is currently being applied, and the paths whose DOM it already
 * has right.
 *
 * Set for the duration of the `transactDoc` call inside the `editCommit` case and read by
 * {@link postPatchToHosts}, which runs synchronously inside it — the same begin/end shape
 * `transact.ts` uses for op recording. Never spans an await, so it cannot leak across messages.
 */
let echoOrigin: { host: HostState; paths: (string | number)[][] } | null = null;

/**
 * Identifies the current visit to a block. Text commits sharing a run fold into ONE history entry —
 * typing commits on every pause, and without this a minute of writing would evict every structural
 * edit from the 100-entry ring and make ⌘Z walk back through the prose one pause at a time.
 */
let editRunSeq = 0;

/**
 * Apply `fn` with `host`'s echo suppression armed for `paths`.
 *
 * This is what lets the caret survive its own edits: committing a block re-enters the patcher,
 * which would otherwise re-render the very subtree the user is typing in.
 */
function withEchoSuppressed(host: HostState, paths: (string | number)[][], fn: () => void): void {
  echoOrigin = { host, paths };
  try {
    fn();
  } finally {
    echoOrigin = null;
  }
}

/** The tab whose document `state`'s iframe currently renders (null when unknown or closed). */
function hostTab(state: HostState): Tab | null {
  return state.tabId ? (workspace.tabs.get(state.tabId) ?? null) : null;
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
      // Track the stylebook selection too: stylebook hosts measure the selected TAG's card
      // (session.selection is deliberately [] in stylebook mode).
      void shell.stylebook.selection;
      for (const host of liveHosts) {
        requestSelection(host, sel);
      }
    });
  });
  selectionWatch = { stop: () => scope.stop() };
}

/** Lazily start one reactive watcher that re-measures remote peers' selections in every host. */
let presenceWatchStarted = false;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;

function ensurePresenceWatch(): void {
  if (presenceWatchStarted) {
    return;
  }
  presenceWatchStarted = true;
  const scope = effectScope(true);
  scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (tab) {
        // Track the roster deeply enough that selection moves re-trigger.
        const { peers } = collabState(tab);
        void peers.map((peer) => JSON.stringify(peer.state.structuralSelection ?? null)).join("|");
      }
      if (presenceTimer) {
        clearTimeout(presenceTimer);
      }
      // Debounced: awareness updates arrive per cursor move.
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        for (const host of liveHosts) {
          requestPresence(host);
        }
      }, 100);
    });
  });
}

/** Measure remote peers' selections in this host's iframe and draw colored boxes from the reply. */
function requestPresence(host: HostState): void {
  if (host.stylebook || !host.ready || !host.iframe.isConnected) {
    return;
  }
  const tab = activeTab.value;
  const peers = tab ? collabState(tab).peers : [];
  host.presenceMeta.clear();
  const paths: (string | number)[][] = [];
  for (const peer of peers) {
    const { structuralSelection } = peer.state;
    if (!structuralSelection || peer.state.focusedPath !== tab?.documentPath) {
      continue;
    }
    const path = [...structuralSelection];
    paths.push(path);
    host.presenceMeta.set(JSON.stringify(path), {
      color: peer.state.user.color,
      label: peer.state.user.name ?? peer.state.user.login,
    });
  }
  if (paths.length === 0) {
    host.presenceReqId = -1;
    host.overlay.setPresence([]);
    return;
  }
  host.selReqId += 1;
  host.presenceReqId = host.selReqId;
  host.channel.post({ kind: "measure", paths, reqId: host.presenceReqId });
}

/** Track the selection on a host and ask its iframe to measure it (or clear the box when null). */
function requestSelection(host: HostState, sel: (string | number)[] | null): void {
  if (host.stylebook) {
    requestStylebookSelection(host);
    return;
  }
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
 * Stylebook variant of {@link requestSelection}: measure the SELECTED TAG's card (the specimen doc
 * addresses selection by tag, not by tab-document path). Cleared when no tag is selected or the tag
 * has no card in this host's generated doc.
 */
function requestStylebookSelection(host: HostState): void {
  if (!host.iframe.isConnected) {
    liveHosts.delete(host);
    return;
  }
  const tag = shell.stylebook.selection;
  const cardPath = tag ? host.stylebook?.tagToCardPath.get(tag) : undefined;
  if (!tag || !cardPath) {
    host.overlay.setSelection(null);
    return;
  }
  if (!host.ready) {
    return;
  }
  host.selReqId += 1;
  host.channel.post({ kind: "measure", paths: [[...cardPath]], reqId: host.selReqId });
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
  // Without a title the whole canvas is an unlabelled frame to assistive tech — and the canvas is
  // The artefact, not chrome.
  iframe.title = "Canvas — live page render";
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
  registerCanvasGutterDrop(canvasEl, () => hosts.get(canvasEl) ?? null);
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
    canvasEl,
    canvasUrl,
    channel,
    editing: false,
    editingProp: null,
    iframe,
    insertHideTimer: null,
    insertHover: false,
    insertZone: null,
    lastRenderedGen: -1,
    lastSelectionRect: null,
    lastSnapshotSeq: 0,
    overlay,
    panReqId: -1,
    pending: null,
    pendingEnterEdit: null,
    pendingTabIds: new Map(),
    presenceMeta: new Map(),
    presenceReqId: -1,
    preview: false,
    ready: false,
    selectionPath: null,
    selReqId: 0,
    snapshot: null,
    stylebook: null,
    tabId: null,
  };
  // The insertion "+" lives on the overlay (the one pointer-events:auto element there). Clicking it
  // Opens the slash menu → mutateInsertNode for the captured zone; mouseenter/leave record whether
  // The cursor is ON it, which both drives the grace timer and VETOES a hide the iframe's (async,
  // Later-arriving) leave post armed underneath the author — see {@link HostState.insertHover}.
  overlay.insertButton.addEventListener("click", (e) => onInsertButtonClick(state, e));
  overlay.insertButton.addEventListener("mouseenter", () => {
    state.insertHover = true;
    cancelInsertHide(state);
  });
  overlay.insertButton.addEventListener("mouseleave", () => {
    state.insertHover = false;
    scheduleInsertHide(state);
  });
  channel.onMessage((msg) => handleMessage(state, msg));
  hosts.set(canvasEl, state);
  liveHosts.add(state);
  ensureSelectionWatch();
  ensurePresenceWatch();
  return state;
}

// ─── Insertion "+" affordance (cross-origin) ────────────────────────────────────

/** Show the "+" for `zone`, capturing it on the host for the click handler; cancels any hide. */
function showInsertZone(state: HostState, zone: InsertZone): void {
  cancelInsertHide(state);
  state.insertZone = zone;
  state.overlay.setInsertZone(canvasRectToParent(zone.rect), zone.edge);
}

/** Hide the "+" immediately and forget the captured zone. */
function hideInsertZoneNow(state: HostState): void {
  cancelInsertHide(state);
  state.insertZone = null;
  state.insertHover = false;
  state.overlay.setInsertZone(null);
}

/**
 * Whether the cursor is on the "+" right now. {@link HostState.insertHover} is the primary signal;
 * the live `:hover` match is a belt-and-braces second one for a button that materialised UNDER an
 * already-stationary cursor (the browser updates `:hover` on that layout change, but a `mouseenter`
 * is not guaranteed).
 */
function insertButtonHovered(state: HostState): boolean {
  const btn = state.overlay.insertButton;
  return state.insertHover || (typeof btn.matches === "function" && btn.matches(":hover"));
}

/**
 * Arm the grace timer to hide the "+" (SALVAGED HIDE_DELAY), replacing any pending one. The hide is
 * SKIPPED when the cursor turns out to be on the button by the time it fires — see
 * {@link HostState.insertHover} for why a cancel-on-mouseenter alone loses that race.
 */
function scheduleInsertHide(state: HostState): void {
  cancelInsertHide(state);
  state.insertHideTimer = setTimeout(() => {
    state.insertHideTimer = null;
    if (insertButtonHovered(state)) {
      return;
    }
    hideInsertZoneNow(state);
  }, INSERT_HIDE_DELAY);
}

/** Cancel a pending grace-timer hide of the "+". */
function cancelInsertHide(state: HostState): void {
  if (state.insertHideTimer !== null) {
    clearTimeout(state.insertHideTimer);
    state.insertHideTimer = null;
  }
}

/**
 * Click the "+": defer to the injected slash-menu → mutateInsertNode handler with the captured
 * zone.
 */
function onInsertButtonClick(state: HostState, e: MouseEvent): void {
  e.stopPropagation();
  e.preventDefault();
  const zone = state.insertZone;
  if (!zone) {
    return;
  }
  insertZoneClickHandler?.(state.overlay.insertButton, zone);
}

/**
 * Messages a PREVIEW render is not allowed to act on. Preview must behave like the shipped page:
 * clicking selects nothing, nothing is outlined, there is no insertion "+", the browser's own
 * context menu stands, nothing can be dropped into it, and no text can be typed into it.
 *
 * The frame withholds most of these itself ({@link file://./iframe-interaction.ts}'s mode gate),
 * but the canvas bundle ships prebuilt in `dist/`, so the host refuses them independently rather
 * than trusting the frame's build to be current. Cleanup messages (`dragEnd`, `fileDragLeave`) are
 * deliberately NOT blocked — they only tear affordances down.
 */
const PREVIEW_BLOCKED: ReadonlySet<IframeToParent["kind"]> = new Set([
  "contextMenu",
  "dragOver",
  "dropResult",
  "editCommit",
  "editCommitProp",
  "editInsert",
  "editMerge",
  "editRangeReplace",
  "editSplit",
  "editStart",
  "fileDragOver",
  "fileDrop",
  "hit",
  "hover",
  "insertZones",
  "layoutHit",
  "nativeDragEnter",
]);

/** Handle a message the iframe posted back: ready handshake, pointer hit/hover, measured geometry. */
function handleMessage(state: HostState, msg: IframeToParent): void {
  if (state.preview && PREVIEW_BLOCKED.has(msg.kind)) {
    return;
  }
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
      // Selecting a real document node retires any layout selection — the two are alternatives, and
      // A stale layout panel next to a fresh element selection would name the wrong thing.
      setLayoutSelection(null);
      // The clicked panel becomes the ACTIVE panel (same as clicking its header): getActivePanel(),
      // Header highlighting, and the style panel's breakpoint context all follow the click — and the
      // Block action bar anchors to the panel the selection was actually made in, not panel 0.
      let panelMedia: string | null = null;
      for (const p of canvasPanels) {
        if (hosts.get(p.canvas as HTMLElement) === state) {
          if (!p.mediaName?.startsWith("git-diff")) {
            panelMedia = panelMediaToActiveMedia(p.mediaName);
            updateUi("activeMedia", panelMedia);
          }
          break;
        }
      }
      // A canvas left-click closes an open context menu — its parent-realm outside-click listener
      // Can't see clicks inside the cross-origin iframe.
      canvasContextMenuHandler?.dismiss();
      // Stylebook host: the path decodes to a TAG (or null = deselect) and routes to the injected
      // Handler — specimen paths are NOT tab-document paths, so session.selection stays untouched.
      if (state.stylebook) {
        const tag = resolveStylebookTag(state.stylebook.pathToTag, msg.hit.path);
        stylebookHitHandler?.(tag, panelMedia);
        if (tag) {
          // Draw immediately from the posted rect; the selection watcher re-measures the CARD.
          const rect = canvasRectToParent(msg.hit.rect);
          state.overlay.setSelection(rect, `<${tag}>`);
          state.lastSelectionRect = rect;
        } else {
          state.overlay.setSelection(null);
        }
        return;
      }
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
    case "layoutHit": {
      // A click on layout chrome — a node with no page-document path, so it can never become a
      // `session.selection`. Before this it selected nothing and posted nothing, which is what made
      // The first click a new user makes (the site name in the header) appear to do nothing at all.
      // Specimen catalogs have no layout, so the stylebook host ignores it.
      if (state.stylebook) {
        return;
      }
      canvasContextMenuHandler?.dismiss();
      setLayoutSelection(msg.hit);
      // Mutually exclusive with a document selection: the inspector renders one panel or the other.
      state.selectionPath = null;
      const tab = activeTab.value;
      if (tab) {
        tab.session.selection = null;
      }
      const rect = canvasRectToParent(msg.hit.rect);
      state.overlay.setSelection(rect, `LAYOUT · ${msg.hit.layoutFile}`);
      state.lastSelectionRect = rect;
      renderOnly("rightPanel");
      return;
    }
    case "hover": {
      if (state.stylebook) {
        // Decode to a tag; suppress the box when hovering the selected tag (legacy parity).
        const tag = msg.hit ? resolveStylebookTag(state.stylebook.pathToTag, msg.hit.path) : null;
        const selected = shell.stylebook.selection;
        if (msg.hit && tag && tag !== selected) {
          state.overlay.setHover(canvasRectToParent(msg.hit.rect));
        } else {
          state.overlay.setHover(null);
        }
        return;
      }
      drawHover(state, msg.hit);
      return;
    }
    case "insertZones": {
      // Document-editing affordance — never for specimen catalogs (belt-and-braces with the
      // Iframe-side mode gate).
      if (state.stylebook) {
        return;
      }
      // The iframe recomputed the insertion "+" zones for the hovered node. Draw the "+" from the
      // First zone's rect (scale=1, D-2 — the overlay is inside the scaled panzoom-wrap); a null/empty
      // Set arms the grace timer rather than hiding immediately, so the cursor can reach the button.
      const zone = msg.zones?.[0] ?? null;
      if (zone) {
        showInsertZone(state, zone);
      } else {
        scheduleInsertHide(state);
      }
      return;
    }
    case "geometry": {
      // Remote-presence reply: draw one colored box per measured peer selection.
      if (msg.reqId === state.presenceReqId) {
        state.presenceReqId = -1;
        const items: { placement: OverlayPlacement; color: string; label: string }[] = [];
        for (const hit of msg.hits) {
          const meta = state.presenceMeta.get(JSON.stringify(hit.path));
          if (meta) {
            items.push({ ...meta, placement: canvasRectToParent(hit.rect) });
          }
        }
        state.overlay.setPresence(items);
        return;
      }
      // Pan-to-card reply (stylebook): convert the card's iframe rect to parent-viewport space by
      // The empirical zoom + iframe offset and center it.
      if (msg.reqId === state.panReqId) {
        state.panReqId = -1;
        const [hit] = msg.hits;
        if (hit) {
          const { rect: ifr, scale } = hostDragGeometry(state);
          panToParentRect({ height: hit.rect.height * scale, top: hit.rect.y * scale + ifr.top });
        }
        return;
      }
      if (msg.reqId === state.selReqId) {
        const [hit] = msg.hits;
        const rect = hit ? canvasRectToParent(hit.rect) : null;
        const sbTag = state.stylebook ? shell.stylebook.selection : null;
        state.overlay.setSelection(rect, sbTag ? `<${sbTag}>` : null);
        if (rect) {
          state.lastSelectionRect = rect;
        }
      }
      return;
    }
    case "evalResult": {
      // A live expression-preview reply (M6). Resolve the pending request by reqId (unknown ids —
      // Already timed out or from a torn-down request — are dropped), gen-gating it so values
      // Computed against a superseded render resolve null (the caller keeps the snapshot preview).
      const resolve = pendingEvals.get(msg.reqId);
      if (!resolve) {
        return;
      }
      pendingEvals.delete(msg.reqId);
      resolve(msg.gen === state.lastRenderedGen ? msg.results : null);
      return;
    }
    case "renderComplete": {
      // Adopt the tab identity this render was mounted with. host.tabId flips ONLY here — after any
      // Edit-session commit the iframe posted ahead of this ack on the FIFO channel — so a commit
      // Racing a tab switch still routes to the tab its session belonged to.
      if (state.pendingTabIds.has(msg.gen)) {
        state.tabId = state.pendingTabIds.get(msg.gen) ?? null;
      }
      for (const gen of state.pendingTabIds.keys()) {
        if (gen <= msg.gen) {
          state.pendingTabIds.delete(gen);
        }
      }
      onDomUpdated(state, msg.gen);
      return;
    }
    case "patchComplete": {
      // A patch never re-targets the host (tabId untouched) — only the DOM/geometry changed.
      onDomUpdated(state, msg.gen);
      return;
    }
    case "renderError": {
      // The render never landed — its pending identity must not be adopted by a later ack.
      state.pendingTabIds.delete(msg.gen);
      return;
    }
    case "dataScope": {
      // The iframe posted its resolved $defs snapshot right after renderComplete. Adopt it into the
      // Parent's canvas state so the data-explorer panel shows live data (buildScope moved into the
      // Iframe realm; the parent hard-codes scope:null at ready). Gate on the last-rendered gen so a
      // Snapshot from a superseded render can't clobber the current one, then re-render the left
      // Panel (which hosts the data-explorer) to reflect the new scope.
      if (msg.gen !== state.lastRenderedGen) {
        return;
      }
      updateCanvas({ scope: msg.scope });
      renderOnly("leftPanel");
      return;
    }
    case "contentHeight": {
      /* Preview keeps the iframe a REAL VIEWPORT: it stays at the CSS height the preview stage gives
         it and scrolls its own document, so `position:sticky`, scroll-driven animation and
         IntersectionObserver reveals fire exactly as they will in production. Growing the frame to
         its content height — what every editing mode needs, so the parent overlay can reach every
         node — is what stopped all three from ever firing in the one view whose job is fidelity. */
      if (state.preview) {
        state.iframe.style.height = "100%";
        state.iframe.style.minHeight = "0px";
        return;
      }
      // Size the iframe element to its document so the canvas never scrolls internally — the parent
      // Canvas pans/scrolls instead, every node stays inside the iframe box (hit-testable), and the
      // Overlay (drawn in canvas space) tracks it. The cssText's 480px `min-height` is a
      // Pre-measurement floor so an empty/short PAGE stays a usable canvas; a component DEFINITION
      // (fragment) instead hugs its content, so drop the floor for it once measured (else a short
      // Component leaves dead space below — pages keep the floor and stay tall via #jx-canvas-root).
      state.iframe.style.height = `${msg.height}px`;
      state.iframe.style.minHeight = msg.fragment ? "0px" : "480px";
      syncEditZoomViewportHeight(state);
      return;
    }
    case "dragOver": {
      // Display-only drop indicator (Phase 4c). Drop stale replies: a different drag session
      // (dragSeq) or a superseded render (gen). The indicator draw side uses scale=1 (D-2) — the
      // Overlay is inside the scaled panzoom-wrap, so the browser already applies the zoom.
      if (msg.dragSeq !== currentDragSeq) {
        return;
      }
      // A cursor-carrying dragOver means the IFRAME is driving the over-stream from its own events
      // (native routing or flow 3) — not merely replying to a parent-forwarded dragMove. Record it
      // BEFORE the gen gate: it's a fact about event routing, not render freshness.
      if (msg.cursor) {
        lastIframeDragOverSeq = msg.dragSeq;
        lastIframeDragOverAt = Date.now();
      }
      if (msg.gen !== state.lastRenderedGen) {
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
    case "nativeDragEnter": {
      if (state.stylebook) {
        return; // A specimen catalog is never a drop target.
      }
      // A parent-originated NATIVE drag crossed onto this iframe before any session bound it (the
      // Parent never sees a cursor inside the iframe rect) — let the bridge bind/migrate here.
      nativeDragEnterHandler?.(state);
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
          applyDropInstruction(hostTab(state), { type: msg.instruction }, srcData, msg.targetPath);
        }
      }
      retainedSrcData.delete(msg.dragSeq);
      // The drop resolved (or was empty) — tear down the display affordances on this host.
      state.overlay.setDropIndicator(null);
      clearDragGhost();
      return;
    }
    case "fileDragOver": {
      if (state.stylebook) {
        return; // A specimen catalog is never a drop target.
      }
      showFileDropAffordance(state, msg.hit, msg.preview);
      return;
    }
    case "fileDragLeave": {
      clearFileDropAffordance(state);
      return;
    }
    case "fileDrop": {
      clearFileDropAffordance(state);
      if (state.stylebook) {
        return;
      }
      void fileDropHandler?.(hostTab(state), msg.files, msg.hit, msg.preview);
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
        activeEditHost.editingProp = null;
        activeEditHost.snapshot = null;
      }
      activeEditHost = state;
      // Each visit to a block is one undoable edit. Bumping the run id here breaks the history
      // Coalescing run, so returning to the same paragraph later is a separate ⌘Z step.
      editRunSeq += 1;
      state.editing = true;
      state.editingProp = msg.prop ?? null;
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
      /* A snapshot posts ONLY from a live session (the frame's `onSelectionChange` returns early
         when nothing is being edited), so it is independent proof that a caret is alive in this
         host — the third of the three messages {@link isCaretActive} is derived from. Adopting the
         host here recovers the flag if the `editStart` that opened the session never landed, and it
         cannot resurrect a finished one: the frame stops posting snapshots before it posts
         `editEnd`, and the channel is FIFO. */
      if (!state.editing) {
        state.editing = true;
        activeEditHost = state;
      }
      toolbarRefresh?.();
      return;
    }
    case "flushComplete": {
      const done = pendingFlushes.get(msg.reqId);
      if (done) {
        pendingFlushes.delete(msg.reqId);
        done();
      }
      return;
    }
    case "editCommit": {
      // Route to the tab this host's iframe renders — NOT activeTab, which may have changed while
      // The message was in flight (the cross-document bleed).
      const apply = () =>
        applyInlineCommit(hostTab(state), msg.path, msg.children, msg.textContent);
      // An in-place commit (the idle tick) leaves the caret in the block, so the echoed patch must
      // Not re-render it. A commit on release renders normally — the caret has already left.
      if (msg.inPlace) {
        withEchoSuppressed(state, [msg.path], apply);
      } else {
        apply();
      }
      return;
    }
    case "editCommitProp": {
      // A prop-bound plain session committed: persist into the instance's $props (same host-tab
      // Routing as editCommit; the unchanged-value no-op lives in the apply).
      //
      // A $props change re-renders the WHOLE component instance, which would tear out the nested
      // Editing host the caret is typing in — so an in-place commit is echo-suppressed exactly as a
      // Page block's is. The instance re-renders for real on release.
      const applyProp = () => applyInlinePropCommit(hostTab(state), msg.path, msg.prop, msg.value);
      if (msg.inPlace) {
        withEchoSuppressed(state, [msg.path], applyProp);
      } else {
        applyProp();
      }
      return;
    }
    case "editMerge": {
      // Joining two blocks removes one of them, so the caret has to be re-placed — at the SEAM,
      // Where the two blocks met, which is where the author's cursor visually was.
      const seam = applyBlockMerge(hostTab(state), msg.fromPath, msg.intoPath);
      if (seam) {
        deferEnterEdit(state, seam.path, seam.offset);
      }
      return;
    }
    case "editRangeReplace": {
      const caret = applyRangeReplace(hostTab(state), msg.from, msg.to, msg.between, msg.text);
      if (caret) {
        deferEnterEdit(state, caret.path, caret.offset);
      }
      return;
    }
    case "editSplit": {
      // The mutation lands now (surgical patch or escalated render); re-entry on the new paragraph
      // Is deferred until this host acks the DOM that contains it (see deferEnterEdit).
      deferEnterEdit(state, applyInlineSplit(hostTab(state), msg.path, msg.before, msg.after));
      return;
    }
    case "editInsert": {
      deferEnterEdit(state, applyInlineInsert(hostTab(state), msg.path, msg.cmd, msg.commitData));
      return;
    }
    case "slashShow": {
      // The iframe engine wants the slash menu at its edited element's rect (iframe-viewport) —
      // Convert to parent-viewport by the empirical zoom + iframe offset and show the real menu.
      // The select/dismiss callbacks post back over THIS host's channel, closing the loop.
      const { rect: ifr, scale } = hostDragGeometry(state);
      const left = msg.rect.x * scale + ifr.left;
      const top = msg.rect.y * scale + ifr.top;
      canvasSlashHandler?.show({
        filter: msg.filter,
        onDismiss: () => state.channel.post({ kind: "slashDismissed" }),
        onSelect: (cmd) => state.channel.post({ cmd: { ...cmd }, kind: "slashSelect" }),
        rect: {
          bottom: top + msg.rect.height * scale,
          height: msg.rect.height * scale,
          left,
          top,
          width: msg.rect.width * scale,
        },
      });
      return;
    }
    case "slashNav": {
      canvasSlashHandler?.nav(msg.key);
      return;
    }
    case "slashDismiss": {
      canvasSlashHandler?.dismiss();
      return;
    }
    case "previewNavigate": {
      openPreviewHref(msg.href, state);
      return;
    }
    case "contextMenu": {
      if (state.stylebook) {
        return; // The doc context menu's actions are meaningless for specimen paths.
      }
      // A canvas right-click — convert to parent-viewport coords and show the Jx element menu.
      const { rect: ifr, scale } = hostDragGeometry(state);
      canvasContextMenuHandler?.show({
        clientX: msg.x * scale + ifr.left,
        clientY: msg.y * scale + ifr.top,
        path: msg.path ? [...msg.path] : null,
      });
      return;
    }
    case "editEnd": {
      // Ignore a superseded late editEnd (a re-enter's stop→start can deliver a stale one): only act
      // When this host is still the one editing.
      if (!state.editing) {
        return;
      }
      state.editing = false;
      state.editingProp = null;
      state.snapshot = null;
      if (activeEditHost === state) {
        activeEditHost = null;
      }
      toolbarRefresh?.();
      break;
    }
    default: {
      break;
    }
  }
}

/**
 * Shared renderComplete/patchComplete bookkeeping: the DOM (and so all geometry) just changed —
 * re-measure the selection box, record the gen the DOM now reflects (cross-frame drag replies are
 * stale-gated against it, Phase 4c), drop the "+" (anchored to a now-stale rect), and flush a
 * deferred split/insert re-entry once the DOM containing the new element is live.
 */
function onDomUpdated(state: HostState, gen: number): void {
  state.lastRenderedGen = gen;
  requestSelection(state, state.selectionPath);
  requestPresence(state);
  hideInsertZoneNow(state);
  if (state.pendingEnterEdit && gen >= state.pendingEnterEdit.minGen) {
    const { offset, path } = state.pendingEnterEdit;
    state.pendingEnterEdit = null;
    // Re-enter only when this host still shows the ACTIVE tab — a background tab's iframe renders a
    // Different doc, so re-entering there would grab the wrong element (the commit itself already
    // Landed in the right tab via hostTab routing).
    if (state.tabId !== null && state.tabId === workspace.activeTabId) {
      reenterEdit(state, path, offset);
    }
  }
}

/**
 * Defer re-entering inline editing on `path` until this host's DOM reflects the split/insert (see
 * {@link onDomUpdated}). `minGen` is the gen the host currently reflects: the surgical patch acks at
 * that same gen; an escalated full render acks at a bumped one — both satisfy `gen >= minGen`,
 * while a stale ack cannot. Latest-wins on overwrite.
 */
function deferEnterEdit(state: HostState, path: (string | number)[], offset?: number): void {
  state.pendingEnterEdit = {
    minGen: state.lastRenderedGen,
    path: [...path],
    ...(offset === undefined ? {} : { offset }),
  };
}

/** Ask the host's iframe to (re-)enter inline editing on `path` (a plain copy crosses the bridge). */
function reenterEdit(state: HostState, path: (string | number)[], offset?: number): void {
  state.channel.post({
    kind: "enterEdit",
    path: [...path],
    ...(offset === undefined ? {} : { offset }),
  });
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
 *
 * `tabId` is the identity of the tab whose document this render shows (null for override docs like
 * git-diff, whose iframes must never route doc mutations anywhere). It is recorded against `gen`
 * and adopted into `host.tabId` only when the iframe acks the render — see
 * {@link HostState.tabId}.
 */
export async function mountIframeCanvas(
  gen: number,
  doc: JxMutableNode,
  canvasEl: HTMLElement,
  widthPx?: number | null,
  tabId: string | null = null,
): Promise<void> {
  const state = ensureHost(canvasEl);
  state.pendingTabIds.set(gen, tabId);
  // A page mount clears any stylebook capability from a previous mode's reuse of this host.
  state.stylebook = null;
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
  // Which tags can hold a caret depends on the document's vocabulary, so the format's verdicts ride
  // With the render rather than being baked into the frame. Absent for a native document, where the
  // Studio's own element metadata answers on its own.
  // Resolve from THIS render's tab, not `state.tabId` — that is only adopted when the render is
  // Acknowledged, so at post time it still names the previous render's document (null on first
  // Mount, which is exactly the render that matters).
  const renderTab = tabId ? (workspace.tabs.get(tabId) ?? null) : null;
  const formatElements = formatByName(renderTab?.doc.sourceFormat)?.studio?.elements;
  const editableTags = formatElements ? formatEditableVerdicts(formatElements) : undefined;
  const message: ParentToIframe = {
    colorScheme: activeSchemeWire(),
    doc: cloneableDoc,
    docBase: resolved.docBase ?? `${canvasBaseOrigin()}/`,
    gen,
    kind: "render",
    mapperCtx: resolved.mapperCtx,
    mode: resolved.mapperCtx.canvasMode as CanvasMode,
    shadowDoc: cloneableShadow,
    siteStyle: resolved.siteStyle,
    ...(editableTags ? { editableTags } : {}),
    ...(consumeAllowAutoRequests() ? { allowAutoRequests: true } : {}),
  };
  // Preview is the fidelity view: no editing messages are honoured from it, no overlay is painted
  // Over it, and the frame stays viewport-sized so it scrolls for real. A mode switch to preview
  // Mid-split must likewise not start an edit session in the preview render.
  state.preview = message.mode === "preview";
  state.overlay.setSuppressed(state.preview);
  if (state.preview) {
    state.pendingEnterEdit = null;
  }
  if (state.ready) {
    state.channel.post(message);
  } else {
    state.pending = message;
  }
}

/**
 * Mount a STYLEBOOK canvas: post the pre-generated specimen document (no `resolveCanvasDocument` —
 * the generator already merged the effective style/media and there is no layout/page mapping) and
 * arm the host's stylebook capability (tag-addressed hits/selection). Mounted with a NULL tab
 * identity: specimen paths are not tab-document paths, so any doc-mutating bridge message from this
 * host must drop — the existing null-tabId routing does exactly that.
 */
export function mountStylebookCanvas(
  gen: number,
  generated: {
    doc: JxMutableNode;
    pathToTag: ReadonlyMap<string, string>;
    tagToCardPath: ReadonlyMap<string, (string | number)[]>;
  },
  canvasEl: HTMLElement,
  widthPx: number | null,
): void {
  const state = ensureHost(canvasEl);
  state.pendingTabIds.set(gen, null);
  state.stylebook = { pathToTag: generated.pathToTag, tagToCardPath: generated.tagToCardPath };
  state.preview = false;
  state.overlay.setSuppressed(false);
  state.pendingEnterEdit = null;
  state.iframe.style.width = widthPx ? `${widthPx}px` : "100%";
  // Two independent plain clones: the iframe renders `doc` and folds styleUpdates into `shadowDoc`
  // (and fake test channels pass messages by reference, so sharing one object would alias them).
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const cloneableDoc = JSON.parse(JSON.stringify(generated.doc)) as unknown;
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const cloneableShadow = JSON.parse(JSON.stringify(generated.doc)) as unknown;
  const message: ParentToIframe = {
    colorScheme: activeSchemeWire(),
    doc: cloneableDoc,
    docBase: `${canvasBaseOrigin()}/`,
    gen,
    kind: "render",
    mapperCtx: {
      arrayPaths: [],
      canvasMode: "stylebook",
      layoutWrapped: false,
      pageContentOffset: null,
      pageContentPrefix: null,
    },
    mode: "stylebook",
    shadowDoc: cloneableShadow,
    // The generator already merged projectConfig.style into the doc's own style block — passing
    // SiteStyle too would double-apply it.
    siteStyle: null,
  };
  if (state.ready) {
    state.channel.post(message);
  } else {
    state.pending = message;
  }
}

/** The active tab's forced preview scheme as wire data (auto → null). */
function activeSchemeWire(): "light" | "dark" | null {
  const s = activeTab.value?.session.ui.previewColorScheme;
  return s === "light" || s === "dark" ? s : null;
}

/**
 * Flip the color-scheme preview on every ready host (page and stylebook alike — both render
 * scheme-aware CSS). A pure attribute write iframe-side: no render, no patch, no gen.
 */
export function postColorSchemeToLiveHosts(scheme: "light" | "dark" | null): void {
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (host.ready) {
      host.channel.post({ kind: "setColorScheme", scheme });
    }
  }
}

/**
 * Push the project's current site style to every ready PAGE host as an in-place sheet replace (live
 * design-token editing — stylebook hosts pre-merge site style into the specimen doc and are
 * skipped). Render-free; the next full render carries the same style via its own siteStyle.
 */
export function postSiteStyleToLiveHosts(): void {
  const config = projectState?.projectConfig;
  if (!config) {
    return;
  }
  // Site config comes off a reactive store — only plain values may cross postMessage.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const siteStyle = JSON.parse(JSON.stringify(config.style ?? null)) as Record<
    string,
    unknown
  > | null;
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const media = JSON.parse(JSON.stringify(config.$media ?? {})) as Record<string, string>;
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (host.ready && !host.stylebook) {
      host.channel.post({ kind: "siteStyleUpdate", media, siteStyle });
    }
  }
}

/**
 * Post a live style update to every ready stylebook host (gen-tagged per host so a stale update is
 * dropped iframe-side; the superseding render carries the same style). Returns how many hosts
 * received it — zero means no stylebook iframe is live yet and the caller should fall through to a
 * full render. Each post is followed by a selection re-measure so the box tracks the reflow.
 */
export function postStyleUpdateToStylebookHosts(style: Record<string, unknown>): number {
  let posted = 0;
  // Style objects come off the reactive doc — only plain values may cross postMessage.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const cloneable = JSON.parse(JSON.stringify(style)) as Record<string, unknown>;
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (host.ready && host.stylebook) {
      host.channel.post({ gen: host.lastRenderedGen, kind: "styleUpdate", style: cloneable });
      posted += 1;
      requestSelection(host, host.selectionPath);
    }
  }
  return posted;
}

/**
 * Pan the canvas so the selected tag's card is centered (layers-panel "locate" affordance). The
 * card lives inside the iframe, so it is measured over the bridge and the reply pans by the
 * converted parent-viewport rect (see the `geometry` handler's panReqId branch).
 */
export function panToStylebookTag(tag: string): void {
  const panel = getActivePanel();
  const host = panel ? (hosts.get(panel.canvas as HTMLElement) ?? null) : null;
  if (!host?.stylebook || !host.ready) {
    return;
  }
  const cardPath = host.stylebook.tagToCardPath.get(tag);
  if (!cardPath) {
    return;
  }
  host.selReqId += 1;
  host.panReqId = host.selReqId;
  host.channel.post({ kind: "measure", paths: [[...cardPath]], reqId: host.selReqId });
}

// ─── Format-toolbar bridge (Phase 4b-2) ─────────────────────────────────────────

/** The host whose iframe currently owns the inline-edit session (or null). */
export function getActiveEditHost(): HostState | null {
  return activeEditHost;
}

/** The current edit session's editing flag + latest selection snapshot, for the parent toolbar. */
export function getEditSnapshot(): {
  editing: boolean;
  editingProp: string | null;
  snapshot: SelectionSnapshot | null;
} {
  if (!activeEditHost) {
    return { editing: false, editingProp: null, snapshot: null };
  }
  return {
    editing: activeEditHost.editing,
    editingProp: activeEditHost.editingProp,
    snapshot: activeEditHost.snapshot,
  };
}

/** Post an `applyFormat` intent to the active edit host's iframe (no-op when none/not ready). */
export function postApplyFormat(intent: ApplyFormatIntent): void {
  const host = activeEditHost;
  if (!host || !host.ready) {
    return;
  }
  host.channel.post({ intent, kind: "applyFormat" });
}

/**
 * Ask the active edit host's iframe to commit-and-end its inline-edit session (no-op when none).
 * The parent calls this when intent leaves the edit surface in the PARENT realm — a tab switch, a
 * chrome click outside the edit toolbars — which the iframe cannot observe itself. The resulting
 * `editCommit` routes by the host's tabId, so a commit racing a tab switch still lands in the
 * document its session belonged to.
 */
export function commitActiveEditSession(): void {
  const host = activeEditHost;
  if (host?.editing && host.ready) {
    host.channel.post({ kind: "endEdit" });
  }
}

/** The live host backing the active panel's canvas (for non-edit selection-bar positioning). */
function hostForActivePanel(): HostState | null {
  const panel = getActivePanel();
  return panel ? (hosts.get(panel.canvas as HTMLElement) ?? null) : null;
}

/**
 * The format toolbar's anchor rect, in PARENT-VIEWPORT space (the bar is `position:fixed`). Both
 * source rects — the edit session's caret snapshot and the `lastSelectionRect` fallback — are in
 * UNSCALED iframe-viewport px (D-2: the overlay draws them inside the scaled panzoom-wrap, so the
 * browser applies the zoom there); the fixed bar gets no such free ride, so scale by the live
 * empirical zoom ({@link hostDragGeometry}) and add the iframe's on-screen offset, whose GBCR
 * already bakes in pan + zoom + ancestor scroll. The empirical ratio covers BOTH scale sources:
 * design mode's panzoom-wrap transform and edit mode's content-zoom counter-scale (where it
 * evaluates to exactly `editZoom` — the iframe's layout width is `renderWidth / editZoom` while its
 * rendered width is `renderWidth`).
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
  const { rect: ifr, scale } = hostDragGeometry(host);
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
    // The fallback rect is overlay-local (same top-left + coordinate space as the iframe viewport).
    return {
      height: host.lastSelectionRect.height * scale,
      left: host.lastSelectionRect.left * scale + ifr.left,
      top: host.lastSelectionRect.top * scale + ifr.top,
      width: host.lastSelectionRect.width * scale,
    };
  }
  return null;
}
