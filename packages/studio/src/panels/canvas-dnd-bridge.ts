/// <reference lib="dom" />
/**
 * Cross-frame canvas DnD coordinator (Phase 4c spike). The canvas is an iframe, and pragmatic-dnd
 * is per-realm, so the parent keeps ONE `monitorForElements` for its drag SOURCES and drives the
 * cross-frame leg as a pointer/message stream: it resolves the target iframe host by hit-testing
 * the pointer against each live host's rect, posts `dragStart`/`dragMove`/`drop`, and the iframe
 * replies with `dragOver`/`dropResult` (handled in iframe-host). The applied mutation runs through
 * the realm-agnostic `applyDropInstruction` with PARENT-retained source data (never crossing the
 * wire).
 *
 * Sources: palette/element/component cards ({type:'block'}, flow 1) and layer rows + the
 * block-action-bar ⠿ handle ({type:'tree-node', path}, flows 2 & 4). Flow 3 (grab-anywhere) enters
 * the SAME coordinator via the iframe's `dragOriginate` ({@link startIframeOriginatedDrag}). The
 * iframe's drop math rejects a tree-node dropped onto its own ancestor/self (canDrop), so no
 * coordinator-side guard is needed.
 *
 * The coordinator is PARENT-authoritative for boundary + host selection + cancel (D-4): each move
 * re-resolves the host by cursor hit-test ({@link liveDragHostAt}) and migrates the session across
 * panels (dragEnd old + dragStart new); a cancel ({@link isCancelDrop}) tears down without
 * applying; a drop with no reply within {@link DROP_RESULT_TIMEOUT} clears the affordances. The
 * drag ghost (D-3) follows the raw pointer 1:1; the drop indicator is drawn host-side from the
 * iframe's `dragOver` preview.
 *
 * The coordinate math is factored into the PURE {@link buildDragMessages} (injected scale + iframe
 * rect) so the cursor conversion is unit-tested without a live iframe or transform.
 */

import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  adoptDragSession,
  beginDragSession,
  clearDropIndicator,
  currentDragSession,
  endDragSession,
  hostDragGeometry,
  liveDragHostAt,
  postDragMessage,
  setIframeOriginateHandler,
} from "../canvas/iframe-host";
import { parentCursorToIframe } from "../canvas/iframe-overlay";
import { clearDragGhost, moveDragGhost, setDragGhost } from "./drag-ghost";
import { getNodeAtPath } from "../store";
import { activeTab } from "../workspace/workspace";
import type { DragHost } from "../canvas/iframe-host";
import type { DragSrcKind, ParentToIframe } from "../canvas/iframe-protocol";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** A parent-viewport pointer position (pragmatic's `location.current.input`). */
interface Cursor {
  x: number;
  y: number;
}

interface MonitorDragArgs {
  source: { data: Record<string, unknown> };
  location: {
    current: { input: { clientX: number; clientY: number } };
    // Pragmatic resets `current` back to `initial` when a drag is CANCELLED (Escape / dropped on no
    // Valid target). The canvas isn't a parent pragmatic drop target, so we detect cancel by that
    // Snap-back rather than an explicit flag (single-sourced through pragmatic, per the spec).
    initial?: { input: { clientX: number; clientY: number } };
  };
}

/**
 * PURE: build the `dragMove` + `drop` parent→iframe messages for a cursor, given the session id and
 * the target iframe's EMPIRICAL `scale` + `rect` (both injected so this is testable without a DOM).
 * The cursor is converted to iframe-viewport coords via {@link parentCursorToIframe} (divide by
 * scale; the iframe rect's left/top cancel the pan). Both leg messages share the one conversion so
 * the move-preview and the authoritative drop never use a divergent coordinate transform.
 */
export function buildDragMessages(
  cursor: Cursor,
  dragSeq: number,
  scale: number,
  iframeRect: { left: number; top: number },
): { move: ParentToIframe; drop: ParentToIframe } {
  const local = parentCursorToIframe(cursor, iframeRect, scale);
  return {
    drop: { cursor: local, dragSeq, kind: "drop" },
    move: { cursor: local, dragSeq, kind: "dragMove" },
  };
}

/** The cursor of a monitor event in parent-viewport coords. */
function cursorOf(location: MonitorDragArgs["location"]): Cursor {
  return { x: location.current.input.clientX, y: location.current.input.clientY };
}

/**
 * Map a pragmatic source's `data` to a realm-agnostic {@link DragSrcKind}, or null when this source
 * doesn't drive the canvas coordinator. Palette/element/component cards are `{type:'block'}` (the
 * fragment is retained parent-side); layer rows + the block-action-bar ⠿ handle are
 * `{type:'tree-node', path}` (a move — the source's existing document path crosses as the kind, and
 * the iframe's `canDrop` rejects ancestor/self targets). Anything else (e.g. a row missing a path)
 * is ignored.
 */
function dragSrcOf(data: Record<string, unknown>): DragSrcKind | null {
  if (data.type === "block") {
    return { type: "block" };
  }
  if (data.type === "tree-node" && Array.isArray(data.path)) {
    return { path: data.path as (string | number)[], type: "tree-node" };
  }
  return null;
}

/**
 * The ghost label for a drag (Phase 4c). A block source uses its fragment's tag (the card label); a
 * tree-node source uses the tag of the node at its path in the live doc (a node chip). Falls back
 * to a generic label when the tag is unknown.
 */
export function ghostLabel(src: DragSrcKind, data: Record<string, unknown>): string {
  if (src.type === "block") {
    const fragment = data.fragment as JxMutableNode | undefined;
    return fragment?.tagName ?? "block";
  }
  const doc = activeTab.value?.doc.document as JxMutableNode | undefined;
  const node = doc ? (getNodeAtPath(doc, src.path) as JxMutableNode | undefined) : undefined;
  return node?.tagName ?? "node";
}

/**
 * Adopt a flow-3 (iframe-ORIGINATED + iframe-DRIVEN) drag session. A drag that begins inside the
 * canvas iframe gets its held-button pointermoves in the IFRAME document (implicit pointer
 * capture), so the parent would never receive them — the iframe therefore drives the whole gesture
 * itself, computing the preview/drop locally and posting `dragOver`/`dropResult` directly.
 *
 * The parent's only job here is to ADOPT the iframe's `seq` (so those replies pass the host's seq
 * gate, see {@link file://../canvas/iframe-host.ts}'s `adoptDragSession`) and SHOW the ghost; the
 * host's `dragOver` handler then positions the ghost from the `cursor` the iframe posts. The parent
 * attaches NO document pointer listeners — it has no pointer of its own during this drag. `path` is
 * the grabbed node's document path; `seq` is the iframe's pre-allocated session id.
 */
export function startIframeOriginatedDrag(
  host: DragHost,
  path: (string | number)[],
  seq: number,
): void {
  const src: DragSrcKind = { path: [...path], type: "tree-node" };
  const srcData = { path: [...path], type: "tree-node" };
  // Adopt the iframe's seq + retain the (path-only) source data; do NOT post dragStart (the iframe
  // Is driving) and do NOT attach parent-document listeners (the iframe owns the pointer it started).
  adoptDragSession(host, src, srcData, seq);
  // Show the ghost; the host's dragOver handler moves it from the iframe-posted cursor each move.
  setDragGhost(ghostLabel(src, srcData), 0, 0);
}

/**
 * Timeout (ms) after a `drop` post before the parent gives up waiting for a `dropResult` and clears
 * the ghost/indicator (the iframe reloaded mid-drag, so no reply will come — treat as cancel).
 */
const DROP_RESULT_TIMEOUT = 250;

/**
 * A live coordinator session. PARENT-authoritative for boundary + host selection (D-4): `host` is
 * the panel the session is currently bound to (its iframe got the latest `dragStart`); `null` while
 * the pointer is off every canvas. `seq` is the session id the bound host's iframe replies with.
 */
interface CoordSession {
  src: DragSrcKind;
  srcData: Record<string, unknown>;
  /** The host whose iframe currently holds the session, or null while off-canvas. */
  host: DragHost | null;
  /** The session id the bound host was started with (for move/drop tagging). */
  seq: number;
  /** The drag ghost's label (computed once at start; the dragged thing doesn't change). */
  label: string;
}

/** Begin a session bound to `host`: bump+post dragStart, show the ghost, record the seq. */
function startSession(
  host: DragHost,
  src: DragSrcKind,
  srcData: Record<string, unknown>,
): CoordSession {
  const seq = beginDragSession(host, src, srcData);
  return { host, label: ghostLabel(src, srcData), seq, src, srcData };
}

/**
 * Advance a session for a new cursor (parent-authoritative boundary, D-4). Moves the ghost 1:1,
 * then resolves the host under the cursor and reconciles:
 *
 * - Same host → post dragMove.
 * - Different host (cross-panel) → MIGRATE: dragEnd the old, dragStart the new (a fresh seq), so the
 *   new panel's iframe drives the rest.
 * - No host (inside→outside) → dragEnd the old + unbind; the ghost keeps following off-canvas.
 */
function sessionDrag(session: CoordSession, cursor: Cursor): void {
  moveDragGhost(cursor.x, cursor.y);
  const target = liveDragHostAt(cursor);
  if (target === session.host) {
    if (target) {
      const { rect, scale } = hostDragGeometry(target);
      postDragMessage(target, buildDragMessages(cursor, session.seq, scale, rect).move);
    }
    return;
  }
  // The bound host changed (migrate) or the pointer left every canvas (unbind).
  if (session.host) {
    postDragMessage(session.host, { dragSeq: session.seq, kind: "dragEnd" });
  }
  if (!target) {
    session.host = null;
    return;
  }
  // Migrate the session to the new panel: a fresh dragStart (new seq) the new iframe replies with.
  session.host = target;
  session.seq = beginDragSession(target, session.src, session.srcData);
  const { rect, scale } = hostDragGeometry(target);
  postDragMessage(target, buildDragMessages(cursor, session.seq, scale, rect).move);
}

/**
 * Finish a session at the drop cursor. Posts `drop` to the host under the cursor (the pointer's
 * panel owns the drop, not the active panel); the iframe computes the drop FRESH and posts
 * `dropResult`, which iframe-host applies + clears the ghost/indicator. A timeout fallback clears
 * the affordances if no reply arrives (iframe reloaded mid-drag). Drops off-canvas release retained
 * data.
 */
function sessionDrop(session: CoordSession, cursor: Cursor): void {
  const target = liveDragHostAt(cursor);
  // Migrate first if the drop landed on a different panel than the last move bound.
  if (target && target !== session.host) {
    if (session.host) {
      postDragMessage(session.host, { dragSeq: session.seq, kind: "dragEnd" });
    }
    session.host = target;
    session.seq = beginDragSession(target, session.src, session.srcData);
  }
  if (!target) {
    if (session.host) {
      postDragMessage(session.host, { dragSeq: session.seq, kind: "dragEnd" });
    }
    endDragSession(session.seq);
    clearDragGhost();
    return;
  }
  const { rect, scale } = hostDragGeometry(target);
  postDragMessage(target, buildDragMessages(cursor, session.seq, scale, rect).drop);
  // The iframe-host's dropResult handler clears the ghost/indicator on a reply; guard against a
  // Reload that never replies by clearing after a short timeout (treated as a cancel).
  const { seq } = session;
  setTimeout(() => {
    if (currentDragSession() === seq) {
      clearDragGhost();
      clearDropIndicator(target);
    }
  }, DROP_RESULT_TIMEOUT);
}

/**
 * Tear down a session WITHOUT applying a drop (Escape/abort): dragEnd the bound host so it clears
 * its indicator + stops auto-scroll, release the retained source data, hide the ghost.
 */
function sessionCancel(session: CoordSession): void {
  if (session.host) {
    postDragMessage(session.host, { dragSeq: session.seq, kind: "dragEnd" });
    clearDropIndicator(session.host);
  }
  endDragSession(session.seq);
  clearDragGhost();
}

/**
 * Whether a pragmatic `onDrop` represents a CANCEL: pragmatic snaps `current` back to `initial` on
 * Escape/abort, so equal input coords (with an `initial` present) signal a cancel rather than a
 * real release. PURE.
 */
export function isCancelDrop(location: MonitorDragArgs["location"]): boolean {
  const { initial } = location;
  if (!initial) {
    return false;
  }
  return (
    initial.input.clientX === location.current.input.clientX &&
    initial.input.clientY === location.current.input.clientY
  );
}

/**
 * Register the single coordinator monitor. Returns a cleanup. Wired once from studio init; the
 * monitor stays for the app's lifetime (pragmatic monitors are global, not per-render).
 */
export function registerCanvasDndBridge(): () => void {
  // The active parent-source (pragmatic) session, or null between drags / before it binds a host.
  let session: CoordSession | null = null;

  // Install the flow-3 handler so the iframe-host's `dragOriginate` case enters this coordinator.
  // The iframe drives the gesture; the parent only adopts the seq + shows the ghost (no listeners).
  setIframeOriginateHandler((host, path, seq) => startIframeOriginatedDrag(host, path, seq));

  return monitorForElements({
    onDrag({ source, location }: MonitorDragArgs) {
      const src = dragSrcOf(source.data);
      if (!src) {
        return;
      }
      const cursor = cursorOf(location);
      if (session) {
        sessionDrag(session, cursor);
        return;
      }
      // The drag started off-canvas (no host bound yet); bind lazily when the pointer enters one.
      const host = liveDragHostAt(cursor);
      if (host) {
        session = startSession(host, src, source.data);
        setDragGhost(session.label, cursor.x, cursor.y);
        sessionDrag(session, cursor);
      }
    },
    onDragStart({ source, location }: MonitorDragArgs) {
      const src = dragSrcOf(source.data);
      if (!src) {
        return;
      }
      const cursor = cursorOf(location);
      const host = liveDragHostAt(cursor);
      // Bind the session to the host under the cursor (if any). The ghost shows immediately and
      // Follows the pointer even before it enters a canvas (lazy bind happens in onDrag otherwise).
      session = host ? startSession(host, src, source.data) : null;
      setDragGhost(ghostLabel(src, source.data), cursor.x, cursor.y);
    },
    onDrop({ source, location }: MonitorDragArgs) {
      const src = dragSrcOf(source.data);
      if (!src) {
        return;
      }
      const cursor = location.current.input ? cursorOf(location) : { x: 0, y: 0 };
      if (!session) {
        // Never bound a host (dropped off every canvas) — just hide the ghost; nothing to apply.
        clearDragGhost();
        return;
      }
      // A cancel (Escape/abort) snaps back to the initial cursor — tear down without applying.
      if (isCancelDrop(location)) {
        sessionCancel(session);
      } else {
        sessionDrop(session, cursor);
      }
      session = null;
    },
  });
}
