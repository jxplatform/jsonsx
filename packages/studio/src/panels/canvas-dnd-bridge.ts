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
 * THIS SLICE: palette→canvas INSERT only ({type:'block'} sources). Layer/handle/grab flows, ghost,
 * highlight, auto-scroll and cancel land in later commits.
 *
 * The coordinate math is factored into the PURE {@link buildDragMessages} (injected scale + iframe
 * rect) so the cursor conversion is unit-tested without a live iframe or transform.
 */

import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  beginDragSession,
  currentDragSession,
  endDragSession,
  hostDragGeometry,
  liveDragHostAt,
  postDragMessage,
} from "../canvas/iframe-host";
import { parentCursorToIframe } from "../canvas/iframe-overlay";
import type { DragSrcKind, ParentToIframe } from "../canvas/iframe-protocol";

/** A parent-viewport pointer position (pragmatic's `location.current.input`). */
interface Cursor {
  x: number;
  y: number;
}

interface MonitorDragArgs {
  source: { data: Record<string, unknown> };
  location: { current: { input: { clientX: number; clientY: number } } };
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

/** Only palette/element/component cards drive this slice; their data is `{type:'block', fragment}`. */
function paletteSrc(data: Record<string, unknown>): DragSrcKind | null {
  return data.type === "block" ? { type: "block" } : null;
}

/**
 * Register the single coordinator monitor. Returns a cleanup. Wired once from studio init; the
 * monitor stays for the app's lifetime (pragmatic monitors are global, not per-render).
 */
export function registerCanvasDndBridge(): () => void {
  // The host the active session is targeting, and its session id. Null between drags / off-canvas.
  let activeHostCursor: Cursor | null = null;

  return monitorForElements({
    onDrag({ source, location }: MonitorDragArgs) {
      const src = paletteSrc(source.data);
      if (!src) {
        return;
      }
      const cursor = cursorOf(location);
      activeHostCursor = cursor;
      const host = liveDragHostAt(cursor);
      if (!host) {
        return;
      }
      const { rect, scale } = hostDragGeometry(host);
      const { move } = buildDragMessages(cursor, currentDragSession(), scale, rect);
      postDragMessage(host, move);
    },
    onDragStart({ source, location }: MonitorDragArgs) {
      const src = paletteSrc(source.data);
      if (!src) {
        return;
      }
      const cursor = cursorOf(location);
      activeHostCursor = cursor;
      const host = liveDragHostAt(cursor);
      if (!host) {
        return;
      }
      // Bump the session + retain the source data (the block fragment never crosses the wire), then
      // Announce the session to the iframe so its dragMove/drop replies carry the matching seq+gen.
      beginDragSession(host, src, source.data);
    },
    onDrop({ source, location }: MonitorDragArgs) {
      const src = paletteSrc(source.data);
      if (!src) {
        return;
      }
      // Resolve the host at the DROP cursor (it may differ from the last move, and the active panel
      // Is irrelevant — the pointer's panel owns the drop).
      const cursor = location.current.input
        ? cursorOf(location)
        : (activeHostCursor ?? { x: 0, y: 0 });
      const dragSeq = currentDragSession();
      const host = liveDragHostAt(cursor);
      if (!host) {
        // Dropped off every canvas — release the retained source data and bail (no mutation).
        endDragSession(dragSeq);
        activeHostCursor = null;
        return;
      }
      const { rect, scale } = hostDragGeometry(host);
      const { drop } = buildDragMessages(cursor, dragSeq, scale, rect);
      // The iframe computes the drop FRESH and posts dropResult; iframe-host applies it (or, if
      // Stale/empty, drops it) and releases the retained source data.
      postDragMessage(host, drop);
      activeHostCursor = null;
    },
  });
}
