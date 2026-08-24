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
import { canvasPerf, recordEscalation, SPAN_PREPARE_RENDER, timeSpanAsync } from "./canvas-perf";
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
import { notify } from "../services/notify";
import { effect, effectScope } from "../reactivity";
import { pathsEqual, projectState, renderOnly } from "../store";
import { activeTab, focusPane, workspace } from "../workspace/workspace";
import {
  paneOfContainer,
  panelHostingCanvas,
  stageContaining,
  tabOfContainer,
} from "./canvas-surface";
import { cloneSelection, primarySelection, toggleSelected } from "../tabs/selection";
import { getNodeAtPath } from "../state";
import type { JxPath } from "../state";
import { setLayoutSelection, shell } from "../shell";
import { formatEditableVerdicts } from "../format/constraints";
import { formatByName } from "../format/format-host";
import { collabState } from "../collab/collab-state";
import { localeDirection } from "@jxsuite/schema/locale";
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
  SerializableRect,
  SerializedKey,
  SyncedChord,
  WireDocOp,
} from "./iframe-protocol";
import type { IframeChannel } from "./iframe-channel";
import type { OverlayLayer, OverlayPlacement } from "./iframe-overlay";
import type { SlashCommand } from "../editor/inline-edit";
import type { Tab } from "../tabs/tab";
import type { JxExpressionNode, JxMutableNode } from "@jxsuite/schema/types";
import { bundleUrl } from "../services/bundle-base";

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
  /** Primary selected path (mirrors `session.selection`'s last entry), for hover de-dupe. */
  selectionPath: (string | number)[] | null;
  /** The whole selection this host last measured, so a re-measure redraws every box. */
  selectionPaths: JxPath[];
  /** Id of the most recent selection `measure` request, so stale `geometry` replies are dropped. */
  selReqId: number;
  /**
   * The NON-primary selected paths the in-flight selection `measure` covers, serialized. The
   * geometry reply draws a co-selection box for every hit whose path is in this set — a set of one
   * selected node leaves it empty, so nothing but the selection box is ever drawn.
   */
  coSelectionKeys: Set<string>;
  /** Id of the most recent presence `measure` request (allocated from the selReqId counter). */
  presenceReqId: number;
  /** Serialized peer path → presence box meta for the in-flight presence measure. */
  presenceMeta: Map<string, { color: string; label: string }>;
  /**
   * Whether this host's iframe currently renders a PREVIEW. Preview is the fidelity view, so the
   * host refuses every editing message from it ({@link PREVIEW_BLOCKED}), suppresses the overlay
   * layer, and leaves the iframe at its CSS height so the frame scrolls its own document.
   *
   * Never assign this directly — go through {@link setHostPreview}, which applies the frame sizing
   * the flag implies in the SAME state transition. See {@link applyFrameSizing}.
   */
  preview: boolean;
  /**
   * The last content height this host's iframe measured and posted, or null before the first
   * measurement. Retained (rather than consumed and dropped) because frame sizing is a function of
   * `preview` too, and the iframe DEDUPES `contentHeight` on an unchanged measurement — so leaving
   * preview cannot rely on a fresh message arriving to restore the content-sized frame.
   */
  contentHeight: number | null;
  /** Whether the last measured content was a component-definition fragment (drops the 480px floor). */
  contentFragment: boolean;
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
   * Surgical patches posted to this iframe that have not acked (`patchComplete`/`patchError`).
   *
   * `pendingTabIds` covers full renders because it has to (identity adoption depends on it); a
   * patch carries no identity, so nothing counted it. Both are "the DOM in that frame does not yet
   * reflect what this host has told it", which is the question {@link canvasIdleBlockers} answers.
   */
  pendingPatches: number;
  /**
   * The frame's own last quiescence report (`{kind: "idle"}`), or null before the first one.
   *
   * Held PER HOST from the start. `shot.ts`'s "Studio's only child frame" is a coin flip the moment
   * P8 adds a second pane, and a global would have to be unpicked exactly then.
   */
  idle: Omit<Extract<IframeToParent, { kind: "idle" }>, "kind"> | null;
  /**
   * Resolvers for {@link measureCanvasPath} requests, keyed by the `measure` reqId.
   *
   * Allocated from the same `selReqId` counter as the selection and presence measures, so the three
   * can never collide and the `geometry` handler can dispatch on the id alone.
   */
  pendingMeasures: Map<number, (hits: NodeHit[]) => void>;
  /**
   * A split/insert re-entry deferred until this host's DOM contains the new element: a surgical
   * patch acks (`patchComplete`) at the SAME gen the host already reflects, an escalated full
   * render acks (`renderComplete`) at a bumped one — both satisfy `gen >= minGen`. An immediate
   * `enterEdit` would race the escalated ASYNC render and silently fail to find the element.
   */
  pendingEnterEdit: {
    path: (string | number)[];
    minGen: number;
    offset?: number;
    /** Set when the deferred re-entry is a PROP host rather than a block (see deferEnterEdit). */
    prop?: string;
  } | null;
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
 * The panes whose NEXT page render may let automatic `$prototype: "Request"` entries fetch, even in
 * edit/design mode.
 *
 * Those fetches are suppressed outside preview because a full render re-resolves every state entry,
 * so an escalating authoring action would issue a request per render. But the Data activity's
 * Refresh exists to re-fire them on demand — its documented purpose — so it arms a pane and that
 * pane's next render consumes it. Deliberately one-shot: a subsequent escalation must not inherit
 * it.
 *
 * **A `boolean`, then a per-PASS boolean, now a set of panes** — the same fact narrowing each time
 * something else turned out to be able to claim it. Per-host was wrong because one Refresh mounts N
 * artboards and the first swallowed the arm. Per-pass was wrong for the same reason one pane
 * further out: two panes are two passes, both scheduled through rAF and both awaiting inside their
 * mount loop, so whichever reached `preparePassRender` first took an arm the OTHER pane's Refresh
 * had set — the button refreshed the pane nobody had pressed it in, and left its own pane
 * suppressed.
 */
const _autoRequestPanes = new Set<string>();

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

/**
 * Arm one pane's next page render to allow automatic request fetches (Data activity Refresh).
 *
 * @param {string} paneId The pane the Refresh was pressed for — read ONCE by the caller, so the arm
 *   and the `renderCanvas` that follows it cannot end up naming different panes.
 */
export function allowAutoRequestsOnNextRender(paneId: string): void {
  _autoRequestPanes.add(paneId);
}

/** Take `paneId`'s arm, if it has one. */
function consumeAllowAutoRequests(paneId: string): boolean {
  return _autoRequestPanes.delete(paneId);
}

/** Pending eval resolvers keyed by reqId; a timeout or stale reply resolves null. */
const pendingEvals = new Map<number, (results: EvalExprResult[] | null) => void>();

/**
 * Which host each in-flight request belongs to.
 *
 * `pendingEvals` and `pendingFlushes` are keyed by reqId alone, which was enough while nothing ever
 * released a host: an unanswered request simply timed out. A pane that goes away has to settle its
 * OWN requests and nobody else's, and the reqId does not say whose they are.
 */
const evalOwners = new Map<number, HostState>();

const flushOwners = new Map<number, HostState>();

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
      evalOwners.delete(reqId);
      resolve(null);
    }, timeoutMs);
    evalOwners.set(reqId, target);
    pendingEvals.set(reqId, (results) => {
      clearTimeout(timer);
      evalOwners.delete(reqId);
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
        flushOwners.delete(id);
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
      flushOwners.set(reqId, host);
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

// ─── Quiescence and point resolution ────────────────────────────────────────────
// Two questions the parent realm could not previously answer about a cross-origin canvas: "has it
// Settled?" and "where on screen is this node?". Both were answered by the CALLER instead — a sleep
// And a `Math.abs(scale - 1) < 0.001` guess at whether a fit transform was in play. Both are the
// Host's own arithmetic; it already does them for the selection overlay and the block action bar.

/** A short, stable handle for a host inside a blocker string. */
function hostLabel(host: HostState): string {
  if (host.stylebook) {
    return "stylebook";
  }
  return host.tabId ?? "unbound";
}

/**
 * Everything the canvas is still owed, one human-readable line per outstanding item, PER HOST.
 *
 * Empty means every live frame's DOM reflects what this host told it, its fonts have loaded, no
 * animation is running and no image retry is in flight. Naming the blockers is the whole point:
 * `probe.idle()` rejects with this list, so a slow subsystem identifies itself instead of being
 * answered with `+500 ms` and a wrong capture (plan §13.4).
 */
export function canvasIdleBlockers(): string[] {
  const blockers: string[] = [];
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    const at = `canvas[${hostLabel(host)}]`;
    if (!host.ready) {
      blockers.push(`${at}: frame has not handshaked`);
      continue;
    }
    const unacked = [...host.pendingTabIds.keys()];
    if (unacked.length > 0) {
      blockers.push(`${at}: gen ${unacked.join(", ")} unacked`);
    }
    if (host.pendingPatches > 0) {
      blockers.push(`${at}: ${host.pendingPatches} unacked patch(es)`);
    }
    if (host.pendingMeasures.size > 0) {
      blockers.push(`${at}: ${host.pendingMeasures.size} measure(s) in flight`);
    }
    const { idle } = host;
    if (!idle) {
      blockers.push(`${at}: no quiescence report yet`);
      continue;
    }
    if (idle.gen !== host.lastRenderedGen) {
      blockers.push(`${at}: quiescence is for gen ${idle.gen}, DOM is gen ${host.lastRenderedGen}`);
    }
    if (!idle.fonts) {
      blockers.push(`${at}: fonts still loading`);
    }
    if (idle.animations > 0) {
      blockers.push(`${at}: ${idle.animations} running animation(s)`);
    }
    if (idle.images > 0) {
      blockers.push(`${at}: ${idle.images} pending image retry(ies)`);
    }
  }
  if (pendingEvals.size > 0) {
    blockers.push(`canvas: ${pendingEvals.size} expression eval(s) in flight`);
  }
  return blockers;
}

/**
 * A node's box in TOP-DOCUMENT coordinates, with `x`/`y` at its centre.
 *
 * The caller gets a point it can act on directly — click it, scroll to it, anchor a popover to it —
 * without knowing that a canvas iframe, a panzoom transform and an edit-zoom scale sit between the
 * document and the screen. P4.6's find-references jump, P8.4's jump bar and collab follow-peer all
 * want exactly this, and so does anything driving Studio from outside.
 */
export interface CanvasPoint {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How long a point request waits for its `geometry` reply before answering null. */
export const MEASURE_TIMEOUT_MS = 500;

/** Frames of an unchanged iframe offset that end a reveal. */
const PAN_SETTLE_FRAMES = 2;

/** Give up on a reveal that never settles rather than await it forever. */
const PAN_SETTLE_MAX_FRAMES = 40;

/**
 * The live host a document path is addressed in: the one rendering the focused tab, else any ready
 * page host. A stylebook host is never it — its paths decode to TAGS, not document paths.
 */
function hostForPath(): HostState | null {
  const tabId = activeTab.value?.id ?? null;
  let fallback: HostState | null = null;
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (!host.ready || host.stylebook) {
      continue;
    }
    if (host.tabId === tabId) {
      return host;
    }
    fallback ??= host;
  }
  return fallback;
}

/**
 * Compose the host's own transforms onto an iframe-viewport rect.
 *
 * `scale` is the EMPIRICAL ratio {@link hostDragGeometry} reads fresh from the DOM, so it covers the
 * design-mode panzoom transform and edit-mode content zoom together — which is precisely the
 * distinction a caller cannot make from outside and used to guess at.
 */
function pointForRect(host: HostState, rect: SerializableRect): CanvasPoint {
  const { rect: frame, scale } = hostDragGeometry(host);
  const left = frame.left + rect.x * scale;
  const top = frame.top + rect.y * scale;
  const width = rect.width * scale;
  const height = rect.height * scale;
  return { height, left, top, width, x: left + width / 2, y: top + height / 2 };
}

/** Ask one host to measure one path and resolve the reply as a top-document point. */
function measureIn(
  host: HostState,
  path: readonly (string | number)[],
): Promise<CanvasPoint | null> {
  return new Promise((resolve) => {
    host.selReqId += 1;
    const reqId = host.selReqId;
    const timer = setTimeout(() => {
      host.pendingMeasures.delete(reqId);
      resolve(null);
    }, MEASURE_TIMEOUT_MS);
    host.pendingMeasures.set(reqId, (hits) => {
      clearTimeout(timer);
      const [hit] = hits;
      resolve(hit ? pointForRect(host, hit.rect) : null);
    });
    // A plain copy: `session.selection` is a reactive proxy and only serializable values cross.
    host.channel.post({ kind: "measure", paths: [[...path]], reqId });
  });
}

/**
 * Where the node at `path` is on screen right now, or null when no canvas can answer.
 *
 * Read-only: it measures, it does not move anything. {@link revealCanvasPath} is the half that does.
 */
export function canvasPointAt(path: readonly (string | number)[]): Promise<CanvasPoint | null> {
  const host = hostForPath();
  return host ? measureIn(host, path) : Promise.resolve(null);
}

/**
 * Resolve once the iframe's offset has stopped moving.
 *
 * The iframe's own top is the right thing to watch precisely because it does not care HOW the pane
 * moved: a Design pan is a 250ms rAF tween of `view.panY`, an Edit reveal is one synchronous
 * `scrollTop` write, and both show up here as the frame's on-screen offset changing and then
 * holding still.
 */
function panSettled(host: HostState): Promise<void> {
  return new Promise((resolve) => {
    let last = Number.NaN;
    let stable = 0;
    let frames = 0;
    const tick = () => {
      const { top } = rectOf(host.iframe);
      stable = top === last ? stable + 1 : 0;
      last = top;
      frames += 1;
      if (stable >= PAN_SETTLE_FRAMES || frames >= PAN_SETTLE_MAX_FRAMES) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Bring the node at `path` into view and answer where it landed.
 *
 * The move is the same {@link panToParentRect} the stylebook's pan-to-card uses, and the second
 * measure is not belt-and-braces: the point BEFORE the move is not the point a caller can act on.
 *
 * `panToParentRect` is what makes this work on BOTH surfaces — it pans a panzoom stage and scrolls
 * a scrolling one. While it only panned, this function was a measured no-op in Edit mode: it
 * returned the node's original, off-screen point, and `runInput`'s caret step then clicked a point
 * outside the pane and selected nothing.
 */
export async function revealCanvasPath(
  path: readonly (string | number)[],
): Promise<CanvasPoint | null> {
  const host = hostForPath();
  if (!host) {
    return null;
  }
  const before = await measureIn(host, path);
  if (!before) {
    return null;
  }
  /* Pan the stage the MEASUREMENT came from. `hostForPath` prefers the host rendering the focused
     tab but falls back to any ready page host, and the pan defaulted to `activeCanvasSurface()` —
     so on the fallback the reveal measured in one pane and scrolled the other, then re-measured a
     node that had not moved. `undefined` keeps the default for a host no pane claims (a detached
     artboard in a test). */
  const surface = panelHostingCanvas(host.canvasEl)?.surface;
  panToParentRect({ height: before.height, top: before.top }, surface);
  await panSettled(host);
  return measureIn(host, path);
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

/**
 * Write the iframe's box from the host's CURRENT state — the render mode and the last content
 * measurement — and nothing else. Frame sizing is derived, never incremental, because the two
 * inputs arrive on different clocks: `preview` flips synchronously inside a mount, the measurement
 * arrives asynchronously over the channel, and the iframe DEDUPES a repeated measurement (so "the
 * next `contentHeight` will fix it" is false). Deriving both branches from one function called at
 * every transition of either input is what makes the two impossible to disagree.
 *
 * Preview keeps the iframe a REAL VIEWPORT: it stays at the CSS height the preview stage gives it
 * and scrolls its own document, so `position:sticky`, scroll-driven animation and
 * IntersectionObserver reveals fire exactly as they will in production. Growing the frame to its
 * content height — what every editing mode needs, so the parent overlay can reach every node — is
 * what stopped all three from ever firing in the one view whose job is fidelity.
 *
 * The cssText's 480px `min-height` is a pre-measurement floor so an empty/short PAGE stays a usable
 * canvas; a component DEFINITION (fragment) instead hugs its content, so drop the floor for it once
 * measured (else a short component leaves dead space below — pages keep the floor and stay tall via
 * `#jx-canvas-root`).
 */
function applyFrameSizing(state: HostState): void {
  if (state.preview) {
    state.iframe.style.height = "100%";
    state.iframe.style.minHeight = "0px";
    return;
  }
  if (state.contentHeight === null) {
    // Nothing measured yet — the cssText defaults (height:100%; min-height:480px) stand.
    return;
  }
  state.iframe.style.height = `${state.contentHeight}px`;
  state.iframe.style.minHeight = state.contentFragment ? "0px" : "480px";
  syncEditZoomViewportHeight(state);
}

/**
 * Adopt a render mode's preview-ness as ONE state transition: the flag, the overlay suppression,
 * the dropped pending edit and the frame box all move together. Mounts must call this rather than
 * assigning `state.preview` — a mount resolves its document asynchronously, so between the mode
 * changing and the flag landing the host would otherwise answer a `contentHeight` with the previous
 * mode's sizing rule and never get a second chance to correct it.
 */
function setHostPreview(state: HostState, preview: boolean): void {
  state.preview = preview;
  state.overlay.setSuppressed(preview);
  if (preview) {
    state.pendingEnterEdit = null;
  }
  applyFrameSizing(state);
}

/**
 * Declare, SYNCHRONOUSLY, which kind of render `canvasEl`'s host is about to receive.
 *
 * {@link mountIframeCanvas} resolves its document asynchronously, so the mode it will post is not
 * known to the host until an await has passed. The renderer knows it before the await — it is the
 * mode it just built the surface for — so it says so here, and the host's frame box moves with the
 * flag rather than trailing it. Without this the `contentHeight` the iframe posts during the
 * resolve is answered under the OUTGOING mode's sizing rule.
 */
export function adoptCanvasPreviewMode(canvasEl: HTMLElement, preview: boolean): void {
  setHostPreview(ensureHost(canvasEl), preview);
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
  /** Whether the menu draws its own filter field — see the `slashShow` message for why. */
  showFilter?: boolean;
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

/** Injected "a pointer went down in a canvas" signal (studio.ts → releaseBlockActionBar). */
let canvasPointerDownHandler: (() => void) | null = null;

/**
 * Register what runs when a canvas frame reports a pointerdown. Pass `null` to unregister.
 *
 * Injected rather than imported for the reason {@link setToolbarRefresh} gives — this module
 * deliberately knows nothing about panels — and it exists as its own seam because
 * {@link focusHostPane} cannot serve as one: `focusPane` returns early when the pane already has
 * focus, which is the ordinary case (clicking around inside the pane you are already in) and
 * precisely the case the one subscriber, the block action bar's suppression release, is for.
 */
export function setCanvasPointerDownHandler(fn: (() => void) | null): void {
  canvasPointerDownHandler = fn;
}

let selectionWatch: { stop: () => void } | null = null;

/** Full-render escalation, injected by studio init (a patchError can't apply surgically). */
let patchEscalation: ((paneId: string) => void) | null = null;

/**
 * Register the full-render fallback the host invokes when the iframe reports a `patchError`.
 *
 * Takes the PANE whose frame reported it: only that stage's DOM has fallen behind its document, and
 * re-rendering the other pane would reload iframes that applied their patch perfectly well.
 */
export function setIframePatchEscalation(fn: (paneId: string) => void): void {
  patchEscalation = fn;
}

/**
 * Post a surgical patch (value-carrying forward ops) to every ready live iframe host rendering
 * `tabId`'s document — a still-connected host showing another tab's doc must never fold a foreign
 * edit into its shadow doc. Returns how many hosts received it; the caller escalates to a full
 * render when that's zero (no host could apply the edit in place, so the suppressed full render
 * must run after all).
 *
 * **There is no `gen` parameter, and there cannot be one.** The generation a frame checks a patch
 * against belongs to the STAGE that frame is mounted on, and this loop deliberately spans stages:
 * one document displayed in two panes is two hosts with two independent `renderGeneration`s. A
 * single number for a multi-pane fan-out is not a parameter needing a better value — it is the bug.
 * Whichever pane had rendered more recently held the higher `renderedGen`, and `iframe-entry.ts`
 * dropped the patch there in silence, leaving a wrong picture on screen with `__jxCanvasPerf`
 * reporting a clean surgical apply. Each host's own generation is resolved inside the loop
 * instead.
 *
 * `host` is deliberately not a pane-scoped parameter name (see `PANE_PARAM_NAMES`), and the body
 * reads no focus: `panelHostingCanvas` resolves the stage from the host's own element.
 */
export function postPatchToHosts(forwardOps: WireDocOp[], tabId: string | null): number {
  let posted = 0;
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (host.ready && host.tabId === tabId) {
      /* NO FALLBACK GENERATION, and `?? 0` was the one bug this whole function exists to end.
         A host whose stage cannot be resolved — still `ready` and connected while its surface's
         panel list is between mutations across one of `renderCanvasImpl`'s awaits — was posted
         gen `0`. `0 < renderedGen` is the frame's `patch-behind-render` branch, whose `patchError`
         is handled by resolving the surface with THIS SAME failing lookup: `patchEscalation` was
         never called. Meanwhile `posted` had been incremented, so the caller did not throw, and
         `markConsumed` had already suppressed the full render. An edit disappeared with no counter
         moving. A stage we cannot name is a stage we cannot patch: skip it, let `posted` fall, and
         let the caller's `no-ready-iframe-host` escalate the whole batch. The escalation counter
         moves HERE too, because "nothing was posted and nothing was wrong" and "nothing was posted
         because we could not name the stage" are the two answers this must never confuse. */
      const stage = panelHostingCanvas(host.canvasEl)?.surface;
      if (!stage) {
        recordEscalation("host-stage-unresolved");
        continue;
      }
      const gen = stage.renderGeneration;
      // Only the host that originated this edit already has the DOM the patch describes. A
      // Split-view panel on the same document did NOT type it and must render normally.
      const echoPaths = echoOrigin?.host === host ? echoOrigin.paths : undefined;
      host.channel.post(
        echoPaths
          ? { echoPaths, forwardOps, gen, kind: "patch" }
          : { forwardOps, gen, kind: "patch" },
      );
      host.pendingPatches += 1;
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
/**
 * Serialized path of an in-place prop commit whose patch was echo-suppressed, or null.
 *
 * One value rather than a set: a plain session edits exactly one prop of one instance at a time,
 * and it is cleared on the release that follows.
 */
let propEchoPending: string | null = null;

/**
 * Serialized instance path whose release commit just transacted, so a `$props` patch rebuilding it
 * is in flight. Read by the very next `editStart` and cleared there — the two messages arrive back
 * to back when the user clicks from one prop slot to another in the same component.
 */
let propRebuildAt: string | null = null;

/**
 * Whether a release commit has to re-render the instance itself.
 *
 * Exported for its own test: the posting side ({@link postPatchToHosts}) needs a resolvable stage
 * and is covered elsewhere, but the STATE MACHINE here is the part that was wrong, and it is three
 * conditions that have to agree — the release must have declined to transact, an in-place commit
 * must have been suppressed, and it must have been for this same instance.
 *
 * @param {boolean} transacted - Whether the release commit wrote to the document.
 * @param {string | null} pending - Serialized path of a suppressed in-place commit, if any.
 * @param {string} path - Serialized path of the instance being released.
 * @returns {boolean}
 */
export function needsReleaseReconcile(
  transacted: boolean,
  pending: string | null,
  path: string,
): boolean {
  return !transacted && pending === path;
}

/**
 * Re-render a component instance from the document, WITHOUT transacting.
 *
 * Used when a release commit legitimately no-ops but the DOM is still showing what the suppressed
 * in-place commits rendered. The op is the same `set-key $props` the patcher would have produced,
 * so it takes the ordinary `replaceSubtree` path — this adds no rendering mechanism, it re-sends
 * the one that was deliberately dropped while the caret needed protecting.
 *
 * @param {HostState} state - The host whose tab owns the document.
 * @param {JxPath} path - The component instance's document path.
 * @returns {void}
 */
function reconcileInstance(state: HostState, path: JxPath): void {
  const tab = hostTab(state);
  if (!tab) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }
  postPatchToHosts([{ key: "$props", op: "set-key", path, value: node.$props }], tab.id);
}

function hostTab(state: HostState): Tab | null {
  return state.tabId ? (workspace.tabs.get(state.tabId) ?? null) : null;
}

/**
 * The tab a drag TARGET is showing — the one public reader on the opaque {@link DragHost} handle.
 *
 * `panels/canvas-dnd-bridge.ts` binds a session to the host under the cursor and then had nothing
 * to ask it, so the one fact it needed about the drag — what the dragged node is CALLED — came from
 * `activeTab`. The bridge is not supposed to read the handle's fields (that is what "opaque"
 * means), so the answer is a function rather than a widened type.
 */
export function dragHostTab(host: DragHost): Tab | null {
  return hostTab(host);
}

/**
 * Put the keyboard in the pane whose artboard was just clicked.
 *
 * `panels/pane-grid.ts` moves the pane focus on a `pointerdown` anywhere in a cell, and that
 * listener cannot see this click: the canvas is a cross-origin `<iframe>`, so a pointer event
 * inside it is delivered in the frame's own realm and never surfaces in the parent's. The `hit` and
 * `layoutHit` messages ARE that pointerdown, re-posted across the channel, so this is the seam.
 *
 * The pane comes from the artboard the message arrived through — `panelHostingCanvas` is the same
 * route the breakpoint and the escalation already take — never from the focus, which is the thing
 * being corrected. `focusPane` is a no-op when the pane already has focus, so the common case
 * (clicking around in the pane you are already in) costs one map lookup.
 */
function focusHostPane(state: HostState): void {
  const paneId = panelHostingCanvas(state.canvasEl)?.surface.paneId;
  if (paneId) {
    focusPane(paneId);
  }
}

/** No selection. A shared frozen empty, so the "this host shows nothing" path allocates nothing. */
const NO_SELECTION: readonly JxPath[] = Object.freeze([]);

/** The tab each pane is showing, by tab id. Reading it inside an effect tracks every pane. */
function shownSelections(): Map<string, readonly JxPath[]> {
  const byTab = new Map<string, readonly JxPath[]>();
  for (const pane of workspace.panes) {
    const tab = pane.activeTabId ? workspace.tabs.get(pane.activeTabId) : null;
    if (!tab) {
      continue;
    }
    const sel = (tab.session.selection ?? []) as readonly JxPath[];
    // Track the selection deeply enough that a change WITHIN the set re-measures: the effect
    // Reads every path, not just the array reference.
    void sel.map((path) => path.join("/")).join("|");
    byTab.set(tab.id, sel);
  }
  return byTab;
}

/**
 * Lazily start one reactive watcher that re-measures each host's OWN document's selection.
 *
 * **Every other fan-out in this module filters by `host.tabId`** — `postPatchToHosts`,
 * `requestCanvasEval`, `flushCanvasEdits` — and this one did not. It read `activeTab` and posted
 * the result to every entry in `liveHosts`, so with two panes open the focused pane's selection
 * paths were measured inside the OTHER pane's frame, against a document that does not contain them,
 * and written over that host's own `selectionPath`/`selectionPaths`. The reverse cost more:
 * `requestSelection`'s `if (!primary)` branch clears the overlay, so the focused pane merely having
 * nothing selected erased the side pane's box — the unfocused pane could never show a selection at
 * all.
 */
function ensureSelectionWatch(): void {
  if (selectionWatch) {
    return;
  }
  const scope = effectScope(true);
  scope.run(() => {
    effect(() => {
      const byTab = shownSelections();
      // Track the stylebook selection too: stylebook hosts measure the selected TAG's card
      // (session.selection is deliberately [] in stylebook mode).
      void shell.stylebook.selection;
      for (const host of liveHosts) {
        requestSelection(host, (host.tabId ? byTab.get(host.tabId) : null) ?? NO_SELECTION);
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
      // EVERY shown tab's roster, for the reason {@link ensureSelectionWatch} gives: a peer moving
      // Their cursor in the side pane's document is a repaint the side pane owes, and tracking only
      // The focused tab left the other pane's presence boxes frozen at whatever it last drew.
      for (const pane of workspace.panes) {
        const tab = pane.activeTabId ? workspace.tabs.get(pane.activeTabId) : null;
        if (!tab) {
          continue;
        }
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
  // THIS host's document, not the focused pane's — the peer boxes drawn in a frame have to be the
  // Peers looking at what that frame is showing, and `peer.state.focusedPath` is compared against
  // It below.
  const tab = hostTab(host);
  const peers = tab ? collabState(tab).peers : [];
  host.presenceMeta.clear();
  const paths: (string | number)[][] = [];
  for (const peer of peers) {
    const { structuralSelection } = peer.state;
    if (!structuralSelection || peer.state.focusedPath !== tab?.documentPath) {
      continue;
    }
    // A peer publishes their whole selection SET (§6.5). Every path gets its own box under the
    // Same name and colour — the meta map is keyed by path, so a peer selecting six nodes draws
    // Six boxes and a peer selecting one draws exactly the one box it always did.
    for (const path of structuralSelection) {
      const copy = [...path];
      paths.push(copy);
      host.presenceMeta.set(JSON.stringify(copy), {
        color: peer.state.user.color,
        label: peer.state.user.name ?? peer.state.user.login,
      });
    }
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

/**
 * Track the selection on a host and ask its iframe to measure it (or clear the boxes when empty).
 *
 * The PRIMARY path is posted first and drawn as the selection box; the rest are drawn as
 * co-selection boxes from the same reply, so one round trip covers the whole set. With one path
 * selected the request is byte-identical to what it always was — one path in, one box out.
 */
function requestSelection(host: HostState, sel: readonly JxPath[]): void {
  if (host.stylebook) {
    requestStylebookSelection(host);
    return;
  }
  const primary = primarySelection(sel);
  host.selectionPath = primary;
  host.selectionPaths = sel as JxPath[];
  if (!host.iframe.isConnected) {
    liveHosts.delete(host);
    return;
  }
  if (!primary) {
    host.coSelectionKeys.clear();
    host.overlay.setSelection(null);
    host.overlay.setCoSelection([]);
    return;
  }
  if (!host.ready) {
    return;
  }
  // Post a plain copy: `session.selection` is a reactive proxy, and only serializable values may
  // Cross the postMessage boundary.
  const others = cloneSelection(sel.slice(0, -1));
  host.coSelectionKeys = new Set(others.map((path) => JSON.stringify(path)));
  host.selReqId += 1;
  host.channel.post({
    kind: "measure",
    paths: [[...primary], ...others],
    reqId: host.selReqId,
  });
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
 * The canvas document, beside the bundle that asked for it.
 *
 * This was the literal `/packages/studio/canvas.html` — a repo dev-server path baked into a browser
 * bundle, correct on exactly one host out of four. It happened to work because every other host
 * overrides `canvasUrl`: the chromium launcher builds one from its token, electrobun fetches one
 * over RPC, and the cloud adapter hard-codes its own. So the default was never the default; it was
 * the dev server's URL with nothing saying so.
 *
 * `bundleUrl` resolves it against the ENTRY's directory, which is the one fact every host agrees on
 * (see services/bundle-base.ts), so the fallback is now correct everywhere rather than accidentally
 * unused.
 */
function defaultCanvasUrl(): string {
  return bundleUrl("../canvas.html");
}

/**
 * Loads nothing, deliberately: what a platform that resolves its canvasUrl LATER gets in the
 * meantime. See {@link StudioPlatform.canvasUrlDeferred}.
 */
const DEFERRED_CANVAS_URL = "about:blank";

/**
 * Release one host: its channel, its overlay, its frame, and everything awaiting a reply from it.
 *
 * A settled-with-nothing reply rather than a dropped promise, because every caller of
 * `requestCanvasEval` / `flushCanvasEdits` / a measure is awaiting one: dropping the entry would
 * hang a save on a frame that no longer exists, and `canvasIdleBlockers()` would go on naming it.
 */
function releaseHost(host: HostState): void {
  host.channel.dispose();
  for (const [reqId, resolve] of pendingEvals) {
    if (evalOwners.get(reqId) === host) {
      pendingEvals.delete(reqId);
      evalOwners.delete(reqId);
      resolve(null);
    }
  }
  for (const [reqId, settle] of pendingFlushes) {
    if (flushOwners.get(reqId) === host) {
      pendingFlushes.delete(reqId);
      flushOwners.delete(reqId);
      settle();
    }
  }
  for (const [, resolve] of host.pendingMeasures) {
    resolve([]);
  }
  host.pendingMeasures.clear();
  host.pendingTabIds.clear();
  cancelInsertHide(host);
  /* The module-level pointer at THIS host goes with it. Everything else here was already released
     and `activeEditHost` was not, so unsplitting a pane with a live inline-edit caret left the
     parent realm believing it was still editing: the format toolbar stayed up anchored to a
     detached frame, and `commitActiveEditSession()` posted `endEdit` through
     `iframe.contentWindow?.postMessage` on a removed frame — an optional-chained silent no-op, so
     the edit was lost without a word. Cleared here rather than guarded at each reader, because
     "the host that owns the edit session" cannot be a host that no longer exists. */
  if (activeEditHost === host) {
    activeEditHost = null;
  }
  host.overlay.root.remove();
  host.iframe.remove();
  hosts.delete(host.canvasEl);
  liveHosts.delete(host);
}

/**
 * Which document this pane's canvas iframe should load.
 *
 * The `canvasUrlDeferred` branch is the one that needs saying. Electrobun resolves its canvasUrl
 * asynchronously — it is this window's loopback port, fetched over RPC inside `activate()` — and
 * until the fix above, the bundle-relative default resolved to nothing servable under `views://`,
 * so an early frame simply failed and `ensureHost` rebuilt against the real URL when it landed. Now
 * that default RESOLVES: `views://studio/canvas.html` is a document electrobun really does stage.
 * An early frame would therefore boot the whole canvas bundle inside the SHELL's app-privileged
 * origin, in a CEF instance running `disable-site-isolation-trials` — and the cross-origin loopback
 * canvas exists precisely so that never happens.
 */
function resolveCanvasUrl(): string {
  if (!hasPlatform()) {
    return defaultCanvasUrl();
  }
  const platform = getPlatform();
  if (platform.canvasUrl) {
    return platform.canvasUrl;
  }
  return platform.canvasUrlDeferred ? DEFERRED_CANVAS_URL : defaultCanvasUrl();
}

/**
 * Release every canvas host mounted under `root`, and say how many there were.
 *
 * The one NON-lazy path out of {@link liveHosts}. Eleven sites prune a disconnected host when they
 * happen to walk the set, which is enough to stop a dead frame being posted to and is not enough to
 * release it: `iframe-channel.ts` adds a `window` "message" listener that only `dispose()` removes,
 * and the sole parent-side `dispose()` was the URL-change rebuild in {@link ensureHost}. So a closed
 * pane — or any mode transition, which detaches every artboard — left one live listener and one
 * overlay subtree per frame, for the life of the window.
 *
 * @param {HTMLElement} root
 * @returns {number} How many hosts were released.
 */
export function releaseCanvasHosts(root: HTMLElement): number {
  let released = 0;
  for (const host of new Set(liveHosts)) {
    if (root.contains(host.canvasEl)) {
      releaseHost(host);
      released += 1;
    }
  }
  return released;
}

/* There is no `liveCanvasHostCount()`. A count the app never reads is a function reachable from
   nothing, which `tests/reachability.test.ts` refuses on principle — and the honest measure was
   already there: {@link releaseCanvasHosts} RETURNS how many it released. */

function ensureHost(canvasEl: HTMLElement): HostState {
  // Read the platform's canvasUrl when one is registered; otherwise fall back to the default. The
  // Dev server leaves it unset, and some tests mount without a platform registered.
  const canvasUrl = resolveCanvasUrl();
  const existing = hosts.get(canvasEl);
  if (existing) {
    if (existing.canvasUrl === canvasUrl) {
      return existing;
    }
    // The platform's loopback canvasUrl arrived after this host was built with the default URL
    // (electrobun resolves it async over RPC) — tear the early iframe down and rebuild against the
    // Right cross-origin origin.
    releaseHost(existing);
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
  registerCanvasGutterDrop(canvasEl, () => hostForCanvas(canvasEl));
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
    contentFragment: false,
    contentHeight: null,
    editing: false,
    editingProp: null,
    iframe,
    insertHideTimer: null,
    insertHover: false,
    coSelectionKeys: new Set<string>(),
    insertZone: null,
    lastRenderedGen: -1,
    lastSelectionRect: null,
    lastSnapshotSeq: 0,
    overlay,
    panReqId: -1,
    pending: null,
    idle: null,
    pendingEnterEdit: null,
    pendingMeasures: new Map(),
    pendingPatches: 0,
    pendingTabIds: new Map(),
    presenceMeta: new Map(),
    presenceReqId: -1,
    preview: false,
    ready: false,
    selectionPath: null,
    selectionPaths: [],
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
      /* The chord table first, before the pending render: a frame that has painted a page the
         author can click into must already know which keystrokes to hand back. */
      const table = keymapSource?.();
      if (table) {
        state.channel.post({ chords: table.chords, kind: "keymap", mac: table.mac });
      }
      if (state.pending) {
        state.channel.post(state.pending);
        state.pending = null;
      }
      // Re-measure the current selection now that the iframe can answer.
      requestSelection(state, state.selectionPaths);
      return;
    }
    case "paneFocus": {
      /* The frame says only that a pointer went down in it. Every mode posts this, including
         preview — see the message's own docstring for the two holes in `hit` that it closes. */
      focusHostPane(state);
      // …and "a pointer went down in a canvas" is exactly what un-hides the block action bar: the
      // Author is back on the surface it belongs to. Harmless in preview, where the bar draws
      // Nothing anyway.
      canvasPointerDownHandler?.();
      return;
    }
    case "hit": {
      /* A click in a canvas is a click in a PANE, and the parent realm never saw it. See
         `focusHostPane`; it goes first so everything below writes into the pane the person is now
         in rather than starting a selection the Inspector will not show. `paneFocus` has usually
         beaten it here, and both stay: the canvas bundle ships prebuilt, so a frame whose build
         predates `paneFocus` must still focus its pane on a click that lands on a node. */
      focusHostPane(state);
      // Both, for the same reason and the same cost: the release is a no-op unless the bar is
      // Actually suppressed, so the pair of calls a modern frame makes is one null check.
      canvasPointerDownHandler?.();
      // Selecting a real document node retires any layout selection — the two are alternatives, and
      // A stale layout panel next to a fresh element selection would name the wrong thing.
      setLayoutSelection(null);
      // The clicked panel becomes the ACTIVE panel (same as clicking its header): getActivePanel(),
      // Header highlighting, and the style panel's breakpoint context all follow the click — and the
      // Block action bar anchors to the panel the selection was actually made in, not panel 0.
      let panelMedia: string | null = null;
      const clicked = panelHostingCanvas(state.canvasEl)?.panel;
      if (clicked && !clicked.mediaName?.startsWith("git-diff")) {
        panelMedia = panelMediaToActiveMedia(clicked.mediaName);
        // The breakpoint belongs to the tab THIS host renders, resolved the same way every other
        // Doc-touching message in this switch resolves it. `updateUi` writes to `activeTab`, which
        // Is the focused pane's tab — so a click in an unfocused pane set the wrong document's
        // Breakpoint, and the Style panel then edited a compound block the person never opened.
        const hitTab = hostTab(state);
        if (hitTab) {
          hitTab.session.ui.activeMedia = panelMedia;
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
      // Ctrl/Cmd-click ACCUMULATES instead — the same modifier the Outline uses, so the two
      // Surfaces answer the same gesture. Without the modifier this is a plain replace, which is
      // What every canvas click has always been.
      state.selectionPath = msg.hit.path;
      state.selectionPaths = [msg.hit.path];
      const tab = hostTab(state);
      if (tab) {
        tab.session.selection = msg.additive
          ? toggleSelected(tab.session.selection, msg.hit.path)
          : [msg.hit.path];
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
      // Layout chrome is still canvas, and clicking it is still a click in a pane.
      focusHostPane(state);
      canvasContextMenuHandler?.dismiss();
      setLayoutSelection(msg.hit);
      // Mutually exclusive with a document selection: the inspector renders one panel or the other.
      state.selectionPath = null;
      state.selectionPaths = [];
      const tab = hostTab(state);
      if (tab) {
        tab.session.selection = [];
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
      // A `measureCanvasPath` caller is waiting on this exact id — answer it and stop. Checked
      // FIRST because these ids come from the same counter as the two overlay measures below, so
      // Falling through would let a point request repaint the selection box.
      const awaiting = state.pendingMeasures.get(msg.reqId);
      if (awaiting) {
        state.pendingMeasures.delete(msg.reqId);
        awaiting(msg.hits);
        return;
      }
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
        // A stylebook host measures a SPECIMEN path — a card in a generated catalogue, which is
        // Not a `session.selection` path at all — so its one hit is its one box, as it always was.
        // Everywhere else the primary is chosen by PATH rather than by position, because a path
        // The iframe could not resolve is simply absent from `hits`.
        const primaryKey = JSON.stringify(state.selectionPath);
        const co: OverlayPlacement[] = [];
        let rect: ParentRect | null = null;
        if (state.stylebook) {
          const [hit] = msg.hits;
          rect = hit ? canvasRectToParent(hit.rect) : null;
        } else {
          for (const hit of msg.hits) {
            const key = JSON.stringify(hit.path);
            if (key === primaryKey) {
              rect = canvasRectToParent(hit.rect);
            } else if (state.coSelectionKeys.has(key)) {
              co.push(canvasRectToParent(hit.rect));
            }
          }
        }
        const sbTag = state.stylebook ? shell.stylebook.selection : null;
        state.overlay.setSelection(rect, sbTag ? `<${sbTag}>` : null);
        state.overlay.setCoSelection(co);
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
      evalOwners.delete(msg.reqId);
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
      state.pendingPatches = Math.max(0, state.pendingPatches - 1);
      onDomUpdated(state, msg.gen);
      return;
    }
    case "idle": {
      // The frame's own quiescence report. Held, not acted on: it is read by
      // {@link canvasIdleBlockers} when something asks whether Studio has settled.
      state.idle = {
        animations: msg.animations,
        fonts: msg.fonts,
        gen: msg.gen,
        images: msg.images,
      };
      return;
    }
    case "renderError": {
      // The render never landed — its pending identity must not be adopted by a later ack.
      state.pendingTabIds.delete(msg.gen);
      // …and no `dataScope` will follow it, so a Refresh waiting on one must stop waiting. Without
      // This the button spins forever on the one failure it most needs to report.
      const failed = hostTab(state);
      if (failed) {
        failed.session.canvas.refreshing = false;
        renderOnly("leftPanel");
      }
      // …and the author is told. `msg.message` was read NOWHERE: the canvas would go blank or stale
      // And the one string that said why was deleted with the pending id. Keyed on the host, so a
      // Render loop that fails every generation is one problem rather than sixty.
      notify.error("The page could not be rendered.", {
        detail: msg.message,
        key: `canvas.render:${hostLabel(state)}`,
        source: "Canvas",
      });
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
      // Onto the tab this host rendered, not the focused one: the snapshot describes THAT
      // Document's `$defs`, and `updateCanvas` would have filed a background pane's data under the
      // Foreground pane's tab — the Data panel then explains a document that is not on screen.
      const scoped = hostTab(state);
      if (scoped) {
        scoped.session.canvas.scope = msg.scope;
        // The answer a pending Refresh was waiting for. Clearing it HERE rather than on a timer is
        // The whole point: a fetch that takes two seconds keeps saying so for two seconds.
        scoped.session.canvas.refreshing = false;
      }
      renderOnly("leftPanel");
      return;
    }
    case "contentHeight": {
      // The measurement is STATE, not an instruction: record it, then re-derive the frame box from
      // (preview flag, last measurement) so the two can never disagree. See applyFrameSizing.
      state.contentHeight = msg.height;
      state.contentFragment = msg.fragment;
      applyFrameSizing(state);
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
      // The patch is no longer outstanding either way; a counter that only went up would wedge
      // Every later idle() behind a message the host already handled.
      state.pendingPatches = Math.max(0, state.pendingPatches - 1);
      /* An UNRESOLVABLE stage escalates nothing, and that is now a complete answer rather than a
         hole. It used to be half of finding 9: `postPatchToHosts` posted a fabricated gen `0` to a
         host whose stage it could not name, the frame answered `patch-behind-render`, and this
         same failing lookup swallowed the escalation while `markConsumed` had already suppressed
         the pane's full render. The post side refuses to post at all now, so reaching here means
         the panel list was replaced BETWEEN the post and the ack — and that replacement is itself
         a newer full render of this stage, which is why scheduling one would rebuild a stage that
         is not stale. See the two tests either side of this in `iframe-host.test.ts`. */
      const failed = panelHostingCanvas(state.canvasEl)?.surface;
      if (failed) {
        patchEscalation?.(failed.paneId);
      }
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
      /* The session that just opened is inside an instance a release commit is about to rebuild —
         defer a re-entry so it survives the patch. Only for the SAME instance: moving to a slot in
         a different component is not disturbed by this rebuild. */
      if (msg.prop !== undefined && propRebuildAt === serializeJxPath(msg.path)) {
        deferEnterEdit(state, msg.path, undefined, msg.prop);
      }
      propRebuildAt = null;
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
        flushOwners.delete(msg.reqId);
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
        propEchoPending = serializeJxPath(msg.path);
        return;
      }
      const transacted = applyProp();
      /*
       * "The instance re-renders for real on release" was only true when the release actually
       * transacted. After an idle tick the release posts the SAME string, the apply no-ops, and no
       * patch is ever generated — so the suppressed in-place render was the last word and the
       * canvas kept showing pre-edit output. Emptying a heading left it visibly empty while the
       * document had dropped the prop entirely, and any SECOND place the component renders that
       * value kept the old one.
       *
       * Reconciling here rather than lifting the no-op: that guard is load-bearing (it is what
       * stops a commit → patch → disturb → re-commit loop, and keeps undo clean), so the fix is to
       * re-render without transacting.
       */
      if (needsReleaseReconcile(transacted, propEchoPending, serializeJxPath(msg.path))) {
        reconcileInstance(state, msg.path);
      }
      propEchoPending = null;
      /*
       * A release that TRANSACTED rebuilds the whole instance — `set-key $props` at the instance
       * path becomes a `replaceSubtree`. If the user got here by clicking a SECOND prop slot in
       * that same instance, the frame has already adopted a marker inside the subtree about to be
       * replaced, so the session it just opened is dead on arrival: the click did nothing and they
       * had to click again. The next `editStart` tells us whether that is what happened.
       */
      propRebuildAt = transacted ? serializeJxPath(msg.path) : null;
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
        ...(msg.showFilter === true ? { showFilter: true } : {}),
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
      /* A right-click is a click, and it is the ONLY message it delivers: `contextmenu` does not
         fire `click`, so `hit` — where the other half of this seam focuses the pane — never
         arrives. Without this line the menu was built against the FOCUSED document while pointing
         at a node in this one: `editor/context-menu.ts` writes `tab.session.selection = [path]`
         before it decides which rows to show, so right-clicking the side pane moved the PRIMARY
         pane's selection to a path from a different document, and Duplicate/Delete/Wrap then
         operated there. When the focused document had no such path the menu returned early and the
         right-click did nothing at all, silently. */
      focusHostPane(state);
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
  requestSelection(state, state.selectionPaths);
  requestPresence(state);
  hideInsertZoneNow(state);
  if (state.pendingEnterEdit && gen >= state.pendingEnterEdit.minGen) {
    const { offset, path, prop } = state.pendingEnterEdit;
    state.pendingEnterEdit = null;
    /* Re-enter only when this host STILL SHOWS THE TAB IT OWES THE CARET TO — which is a question
       about this host's pane, not about the focus. A background tab's iframe renders a different
       document, so re-entering there would grab the wrong element; the commit itself already landed
       in the right tab via `hostTab` routing.
       This asked `workspace.activeTabId` for two phases, which is the same question only while
       there is one stage. With two, the side pane could be displaying its tab, holding a caret it
       owed, and drop it because the PRIMARY had focus. */
    if (state.tabId !== null && state.tabId === tabOfContainer(state.canvasEl)?.id) {
      reenterEdit(state, path, offset, prop);
    }
  }
}

/**
 * Defer re-entering inline editing on `path` until this host's DOM reflects the split/insert (see
 * {@link onDomUpdated}). `minGen` is the gen the host currently reflects: the surgical patch acks at
 * that same gen; an escalated full render acks at a bumped one — both satisfy `gen >= minGen`,
 * while a stale ack cannot. Latest-wins on overwrite.
 */
function deferEnterEdit(
  state: HostState,
  path: (string | number)[],
  offset?: number,
  prop?: string,
): void {
  state.pendingEnterEdit = {
    minGen: state.lastRenderedGen,
    path: [...path],
    ...(offset === undefined ? {} : { offset }),
    ...(prop === undefined ? {} : { prop }),
  };
}

/** Ask the host's iframe to (re-)enter inline editing on `path` (a plain copy crosses the bridge). */
function reenterEdit(
  state: HostState,
  path: (string | number)[],
  offset?: number,
  prop?: string,
): void {
  state.channel.post({
    kind: "enterEdit",
    path: [...path],
    ...(offset === undefined ? {} : { offset }),
    ...(prop === undefined ? {} : { prop }),
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
  /* The wheel goes back to the stage this FRAME is mounted on, not to "the canvas".
     `canvasWrap` was the focused pane's stage, so a wheel forwarded out of an unfocused pane's
     iframe panned the other pane. Resolved from the DOM rather than from the panel bookkeeping,
     because the frame is physically inside exactly one stage whether or not a pass has recorded an
     artboard for it yet. */
  const stage = stageContaining(state.canvasEl)?.wrap;
  if (!stage) {
    return;
  }
  stage.dispatchEvent(
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
 * The part of a `render` message that is a fact about the DOCUMENT rather than about a host: the
 * resolved and wire-serialized document, its base, the path-mapper context, the mode and the site
 * style. Everything a host contributes — its width, its preview flag, its tab-id bookkeeping —
 * stays outside.
 */
type PreparedRender = Omit<
  Extract<ParentToIframe, { kind: "render" }>,
  "colorScheme" | "gen" | "kind"
>;

/** One render pass's prepared payloads, by document IDENTITY. */
type PreparedDocs = Map<
  JxMutableNode,
  { tabId: string | null; viewTabId: string | null; payload: Promise<PreparedRender> }
>;

/**
 * How many render passes may be prepared at once. Two panes, each mid-pass, plus slack.
 *
 * A ceiling rather than "however many are in flight", because nothing tells this module when a pass
 * ENDS: the last artboard of a pass is indistinguishable from the first artboard of the next one. A
 * small LRU is the honest bound — a pass whose artboards are still arriving is always among the
 * most recently touched, and anything older cannot be reused by anyone.
 */
const PREPARED_PASS_LIMIT = 4;

/**
 * The prepared payload for every render pass in flight, keyed by generation.
 *
 * A design-mode canvas draws one artboard per breakpoint, and every one of them renders the SAME
 * document at a different viewport width. Resolving it per artboard meant N layout merges, N
 * edit-mode transforms, 2N whole-document JSON round trips — and, on a dynamic-route page, N
 * backend round trips, because `resolveParamBoundState` POSTs each param-bound state entry to
 * `/__jx_resolve__` and that ran once per host. The pass resolves once and every host is fed from
 * the result.
 *
 * **It was ONE pass, and a second stage is what made that wrong.** The slot was replaced whenever
 * `gen` differed, on the reasoning that "a render pass is exactly one generation, so the map is
 * dropped whole when the next pass starts". That holds while a pass is the only thing running. Both
 * stages schedule through rAF and `mountIframeCanvas` awaits inside the loop, so two passes
 * INTERLEAVE at every await: pane A's second artboard came back to a slot pane B had just claimed,
 * re-resolved and re-serialized a document that had been prepared moments earlier, and evicted pane
 * B's in turn. Three preparations for three artboards — the fan-out this cache exists to remove,
 * restored exactly by the second pane.
 *
 * Within a generation the key is document IDENTITY, because git-diff mounts two different documents
 * under one generation and each gets its own entry. `tabId` rides along because `editableTags` is
 * derived from it, and the VIEW tab's id beside it because the whole resolution is derived from
 * THAT — the document path, the layout toggle, the preview params and the mode. A mismatch in
 * either re-prepares rather than reusing. `tabId` alone would not do: an override render nulls it,
 * so two git-diff documents would agree on `null` while being views of different tabs.
 */
const preparedPasses = new Map<number, PreparedDocs>();

/**
 * This generation's prepared documents, created on first mention and touched to the front.
 *
 * Insertion order is the LRU order: re-inserting on every access is what keeps two interleaved
 * passes both live no matter how long they alternate, while a pass nobody has touched for four
 * generations falls off the end.
 */
function preparedDocsFor(gen: number): PreparedDocs {
  const existing = preparedPasses.get(gen);
  if (existing) {
    preparedPasses.delete(gen);
    preparedPasses.set(gen, existing);
    return existing;
  }
  const fresh: PreparedDocs = new Map();
  preparedPasses.set(gen, fresh);
  for (const stale of preparedPasses.keys()) {
    if (preparedPasses.size <= PREPARED_PASS_LIMIT) {
      break;
    }
    preparedPasses.delete(stale);
  }
  return fresh;
}

/**
 * Resolve + serialize `doc` for the wire, once per render pass.
 *
 * Returns the SAME promise to every host in the pass, so the second artboard awaits the first one's
 * work instead of repeating it. The payload objects it yields are shared by reference across the
 * messages posted to each host: `postMessage` structured-clones on the way into each frame, so
 * every iframe still folds patches into a shadow doc that is its own. Nothing may mutate a
 * `PreparedRender` after it is built.
 */
function preparePassRender(
  gen: number,
  doc: JxMutableNode,
  tabId: string | null,
  viewTab: Tab | null,
  paneId: string,
): Promise<PreparedRender> {
  const byDoc = preparedDocsFor(gen);
  const viewTabId = viewTab?.id ?? null;
  const cached = byDoc.get(doc);
  if (cached && cached.tabId === tabId && cached.viewTabId === viewTabId) {
    return cached.payload;
  }
  // One-shot per PANE's pass, not per host and not globally. `allowAutoRequestsOnNextRender` arms
  // "the next render of pane X": consuming it inside the per-host mount meant whichever artboard
  // Mounted first swallowed it and the rest re-rendered with automatic `Request` entries still
  // Suppressed, and consuming a GLOBAL here meant whichever PANE's pass got here first did the
  // Same to the other one. `gen` comes from one monotonic counter shared by every surface, so a
  // Pass belongs to exactly one pane and this consume is that pane's.
  const allowAutoRequests = consumeAllowAutoRequests(paneId);
  const payload = timeSpanAsync(SPAN_PREPARE_RENDER, async (): Promise<PreparedRender> => {
    canvasPerf.renderPreparations += 1;
    const resolved = await resolveCanvasDocument(doc, viewTab);
    // The doc must be structured-cloneable to cross postMessage. A Jx document is JSON by contract,
    // So a JSON round-trip (NOT structuredClone, which would throw) drops residual functions /
    // Reactive proxy artifacts that would otherwise raise DataCloneError and silently drop the
    // Entire message.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    const cloneableDoc = JSON.parse(JSON.stringify(resolved.renderDoc)) as unknown;
    // The RAW page doc (forward-op + data-jx-path coordinate space) crosses as the shadow doc.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    const cloneableShadow = JSON.parse(JSON.stringify(doc)) as unknown;
    // Which tags can hold a caret depends on the document's vocabulary, so the format's verdicts
    // Ride with the render rather than being baked into the frame. Absent for a native document,
    // Where the studio's own element metadata answers on its own.
    // Resolve from THIS render's tab, not any host's `tabId` — that is only adopted when a render is
    // Acknowledged, so at post time it still names the previous render's document (null on first
    // Mount, which is exactly the render that matters).
    const renderTab = tabId ? (workspace.tabs.get(tabId) ?? null) : null;
    const formatElements = formatByName(renderTab?.doc.sourceFormat)?.studio?.elements;
    const editableTags = formatElements ? formatEditableVerdicts(formatElements) : undefined;
    return {
      doc: cloneableDoc,
      docBase: resolved.docBase ?? `${canvasBaseOrigin()}/`,
      mapperCtx: resolved.mapperCtx,
      mode: resolved.mapperCtx.canvasMode as CanvasMode,
      shadowDoc: cloneableShadow,
      siteStyle: resolved.siteStyle,
      ...(editableTags ? { editableTags } : {}),
      ...(allowAutoRequests ? { allowAutoRequests: true } : {}),
    };
  });
  byDoc.set(doc, { payload, tabId, viewTabId });
  return payload;
}

/**
 * Render `doc` into the iframe canvas mounted in `canvasEl`: resolve the document once for the
 * whole render pass ({@link preparePassRender}) and post it to this host (queued until the iframe
 * is `ready`).
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
 *
 * `viewTab` is a DIFFERENT question and that is why it is a second parameter: `tabId` asks "where
 * do this frame's mutations go", `viewTab` asks "whose document path, layout toggle, preview params
 * and canvas mode resolve it". They diverge for exactly the override case — a git-diff render has
 * no mutation target but is still a view OF the tab whose diff it is, and its `docBase` and edit
 * transform must come from that tab. The default derives it from the element, the way
 * `paneOfContainer` does everywhere else stage content is handed a host and nothing else; the one
 * production caller (`canvas-render.ts`) passes `tabOfPane(surface.paneId)` explicitly, because it
 * has already resolved it to pick the document.
 */
export async function mountIframeCanvas(
  gen: number,
  doc: JxMutableNode,
  canvasEl: HTMLElement,
  widthPx?: number | null,
  tabId: string | null = null,
  viewTab: Tab | null = tabOfContainer(canvasEl),
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
  const prepared = await preparePassRender(gen, doc, tabId, viewTab, paneOfContainer(canvasEl));
  const message: ParentToIframe = {
    ...prepared,
    // Per-TAB, and read at POST time so a scheme flip that raced the shared resolution is not
    // Baked into the payload every host shares. `viewTab` is this artboard's tab — defaulted from
    // `tabOfContainer(canvasEl)`, the same route the rest of this mount takes.
    colorScheme: schemeWireFor(viewTab),
    gen,
    kind: "render",
  };
  // Preview is the fidelity view: no editing messages are honoured from it, no overlay is painted
  // Over it, and the frame stays viewport-sized so it scrolls for real. A mode switch to preview
  // Mid-split must likewise not start an edit session in the preview render. The flag and the frame
  // Box move together (setHostPreview) — this assignment sits AFTER an await, so any contentHeight
  // That landed while the document resolved was answered under the previous mode's rule.
  setHostPreview(state, message.mode === "preview");
  deliverRender(state, message);
}

/**
 * Hand a host its render — straight down the channel when the iframe is up, queued as `pending`
 * until it says `ready`. Counted either way: the message is this pass's work for this host whether
 * or not the frame has finished loading.
 */
function deliverRender(state: HostState, message: ParentToIframe): void {
  canvasPerf.hostRenderPosts += 1;
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
  setHostPreview(state, false);
  state.pendingEnterEdit = null;
  state.iframe.style.width = widthPx ? `${widthPx}px` : "100%";
  // Two independent plain clones: the iframe renders `doc` and folds styleUpdates into `shadowDoc`
  // (and fake test channels pass messages by reference, so sharing one object would alias them).
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const cloneableDoc = JSON.parse(JSON.stringify(generated.doc)) as unknown;
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const cloneableShadow = JSON.parse(JSON.stringify(generated.doc)) as unknown;
  const message: ParentToIframe = {
    // The specimen carries no tab identity, but the STAGE it is mounted into does: a stylebook is
    // Opened as a tab like anything else, and its `previewColorScheme` is that tab's.
    colorScheme: schemeWireFor(tabOfContainer(canvasEl)),
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
  deliverRender(state, message);
}

/**
 * A TAB's forced preview scheme as wire data (auto → null).
 *
 * Takes its tab, and that is the whole fix. It was `activeSchemeWire()` — zero-argument, reading
 * `activeTab` — and both mounts call it while holding the artboard they are rendering INTO, so
 * every render of the side pane posted the FOCUSED tab's scheme over its own: a side tab set to
 * Dark rendered light whenever an Auto tab had the keyboard, and a side tab set to Auto rendered
 * dark whenever a Dark one did. Its own control went on saying what it had been set to, because the
 * record it reads is the one nobody wrote.
 *
 * This is verbatim the defect {@link postColorSchemeToLiveHosts} was given a `root` for. The PUSH
 * path was scoped and the RENDER path was not, and the per-pane effect in `studio.ts` only re-runs
 * when the scheme CHANGES — so nothing repaired the pane afterwards, and any later re-render (a
 * document edit, a breakpoint change, a mode switch) silently reverted it again.
 */
function schemeWireFor(tab: Tab | null): "light" | "dark" | null {
  const s = tab?.session.ui.previewColorScheme;
  return s === "light" || s === "dark" ? s : null;
}

/**
 * Flip the color-scheme preview on every ready host (page and stylebook alike — both render
 * scheme-aware CSS). A pure attribute write iframe-side: no render, no patch, no gen.
 */
export function postColorSchemeToLiveHosts(
  scheme: "light" | "dark" | null,
  root?: HTMLElement | null,
): void {
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    /* Scoped to one stage when the caller names one. The preview scheme is a per-TAB choice
       (`session.ui.previewColorScheme`), so with two live hosts an unscoped post flipped the other
       pane's document to a scheme nobody had asked it for — and left its own control still saying
       "Auto", because the record it reads belongs to the tab that was never changed. */
    if (root && !root.contains(host.iframe)) {
      continue;
    }
    if (host.ready) {
      host.channel.post({ kind: "setColorScheme", scheme });
    }
  }
}

/**
 * Flip the artboard's language on every ready host — `lang` and `dir`, and nothing else.
 *
 * This is what makes `i18n.switchLocale` a rendering context rather than a chip. Jx has no message
 * catalogue, so the text does not change; the direction does, and a layout that only mirrors in
 * production is a layout an author cannot check before shipping it.
 *
 * SCOPED to one stage when the caller names one, for the reason {@link postColorSchemeToLiveHosts}
 * carries the same parameter: the preview locale is a per-TAB choice, so with two live hosts an
 * unscoped post redraws the other pane's document in a language nobody asked it for — and leaves
 * its own control still naming the language it was never moved off.
 *
 * `dir` is computed here and sent with the tag: `localeDirection` is CLDR's answer through
 * `Intl.Locale`, and a frame deriving it again is a second copy of the RTL script list to keep.
 */
export function postLocaleToLiveHosts(locale: string | null, root?: HTMLElement | null): void {
  const dir = localeDirection(locale);
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (root && !root.contains(host.iframe)) {
      continue;
    }
    if (host.ready) {
      host.channel.post({ dir, kind: "setLocale", locale });
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
      requestSelection(host, host.selectionPaths);
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
  const host = hostForActivePanel();
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

/** The current edit session's editing flag + latest selection snapshot, for the parent toolbar. */
export function getEditSnapshot(): {
  editing: boolean;
  editingProp: string | null;
  snapshot: SelectionSnapshot | null;
} {
  /* The same connectivity guard {@link isCaretActive} has, and for the same reason: a session
     belongs to a frame, and a frame that has left the document has no caret in it. `releaseHost`
     clears `activeEditHost`, so this is the second line rather than the first — it covers the frame
     detached by something that never routed through a release (a `hardClearCanvasWrap`, a mode
     transition mid-session), where an unguarded `editing: true` keeps the format toolbar on screen
     anchored to nothing. */
  const host = activeEditHost;
  if (!host || !host.iframe.isConnected) {
    return { editing: false, editingProp: null, snapshot: null };
  }
  return {
    editing: host.editing,
    editingProp: host.editingProp,
    snapshot: host.snapshot,
  };
}

/**
 * The chord table every live canvas frame forwards against, and the source it is computed from.
 *
 * `setKeymapSource` is called once at bootstrap with the app's registry, and again by nothing:
 * {@link publishKeymap} re-reads it, so a rebinding in Preferences reaches the canvas by the host
 * calling `publishKeymap()` rather than by anyone holding a stale copy.
 */
let keymapSource: (() => { mac: boolean; chords: readonly SyncedChord[] }) | null = null;

/**
 * Tell the host how to read the live chord table.
 *
 * Injected rather than imported so this module keeps its one direction of dependency: the canvas
 * host knows nothing about the command registry, and the bootstrap that owns both wires them.
 */
export function setKeymapSource(
  source: () => { mac: boolean; chords: readonly SyncedChord[] },
  onChange?: (listener: () => void) => () => void,
): void {
  keymapSource = source;
  // A copy with no invalidation is a second authority that drifts. `onChange` fires when the user
  // Rebinds a key, and reposting is what makes Preferences › Keyboard reach inside the canvas —
  // Which three hand-written lists in `iframe-keys.ts` could never do.
  onChange?.(() => publishKeymap());
  publishKeymap();
}

/**
 * Send the current chord table to every live frame.
 *
 * Called on a frame's `ready` (so a newly mounted canvas is never guessing) and whenever the keymap
 * changes (so rebinding ⌘B in Preferences rebinds it inside the page too — the thing three
 * hand-written lists in `iframe-keys.ts` could never do).
 */
export function publishKeymap(): void {
  const table = keymapSource?.();
  if (!table) {
    return;
  }
  for (const host of liveHosts) {
    if (!host.iframe.isConnected) {
      liveHosts.delete(host);
      continue;
    }
    if (host.ready) {
      host.channel.post({ chords: table.chords, kind: "keymap", mac: table.mac });
    }
  }
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
 * Ask the active edit host's iframe to open the slash menu at its caret.
 *
 * The same shape and the same guard as {@link postApplyFormat}: the caret lives in the other realm,
 * so a command in this one can only ask. `activeEditHost` is null when no session is live, which is
 * exactly when `insert.openSlashMenu` refuses.
 */
export function postOpenSlash(): void {
  const host = activeEditHost;
  if (!host || !host.ready) {
    return;
  }
  host.channel.post({ kind: "openSlash" });
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
  // `isConnected` too: posting into a removed frame is an optional-chained no-op inside the
  // Channel, so the caller is told the commit was requested when nothing received it.
  if (host?.editing && host.ready && host.iframe.isConnected) {
    host.channel.post({ kind: "endEdit" });
  }
}

/** The live host backing the active panel's canvas (for non-edit selection-bar positioning). */
function hostForActivePanel(): HostState | null {
  const panel = getActivePanel();
  return panel ? hostForCanvas(panel.canvas as HTMLElement) : null;
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
