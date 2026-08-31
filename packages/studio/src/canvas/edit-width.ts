/// <reference lib="dom" />
/**
 * Edit-width — the Edit canvas's dragged width, and the breakpoint that width implies.
 *
 * Edit draws ONE column, and until now that column could only be one of the widths a project
 * declares: the Size switcher wrote `session.ui.activeMedia` and `canvas-render.ts` looked the
 * matching `$media` entry's width up. Everything BETWEEN two declared widths — which is where a
 * responsive layout actually breaks — was unreachable without editing `project.json`. A handle on
 * either side of the column makes the width continuous, and this module is what those handles
 * drag.
 *
 * **The width picks the breakpoint, not only the other way round.** Crossing a band writes
 * `activeMedia`, so the Context bar, the Style tab's Target Line and therefore the block a style
 * edit lands in all follow the width on screen. One axis, one field (`studio.md` §6.2) — a canvas
 * at 700px that still claimed to be at Base would be a control over a label.
 *
 * **Nothing here is persisted, and that is the whole design.** The drag is an inspection gesture:
 * the record dies with the mode (`canvas-render.ts` clears it on a mode transition) and is never
 * written to `localStorage`. What DOES survive is the breakpoint it landed on, because
 * `activeMedia` already persists (`workspace/session.ts`) — so a relaunch reopens the document at
 * that breakpoint's declared width, which is a truthful summary of where you left off.
 *
 * **The store is a module-local `Map` keyed by pane**, the shape `_fits` and `_editZoomRafs` in
 * `canvas-utils.ts` already use, rather than a field on `CanvasSurface`: the value is transient and
 * its only readers are the render pass and the drag itself.
 *
 * **A record carries the media it was written beside, and that is how it self-invalidates.** The
 * alternative was for `canvas.setBreakpoint` to call `clearEditWidth`, which would have made
 * `canvas-utils.ts` import this module while this module imports `applyEditZoom` from it — a cycle,
 * for a fact both sides can already see. Instead: the drag writes width and media together, so any
 * OTHER writer of `activeMedia` (the Size popover, an artboard header) leaves the record
 * disagreeing with the tab, and a disagreeing record is discarded. The axis stays single-writer per
 * gesture without anyone having to be told.
 *
 * **This file is a LEAF, and stays one.** The command `canvas.setEditWidth` lives in
 * `canvas-utils.ts` beside the other rendering-context verbs, and the drag in `edit-width-drag.ts`
 * needs `applyEditZoom` from that same module — so a store that reached for either would close a
 * cycle between them. It imports nothing but the media model, and both sides import it.
 *
 * @docs studio/design/breakpoints
 */

import { getEffectiveMedia } from "../site-context";
import { mediaForWidth, parseMediaEntries } from "../utils/canvas-media";
import type { CanvasSurface } from "./canvas-surface";
import type { Tab } from "../tabs/tab";

/**
 * The narrowest the column may be dragged.
 *
 * Below roughly this a page is no longer a page — 240px is narrower than any device a project is
 * likely to declare, so the floor never gets in the way of a real breakpoint, and it stops the
 * column collapsing to a sliver the handles cannot be prised back apart from.
 */
export const EDIT_WIDTH_MIN = 240;

/** How close a drag must come to a declared width before it is pulled onto it. */
export const EDIT_WIDTH_SNAP_TOLERANCE = 8;

/**
 * The clearance `.content-edit-canvas` keeps on each side of the column.
 *
 * It is what stops the handles — which hang OUTSIDE the column's box — being clipped by that
 * container's `overflow-x: hidden`, so it must stay at least as wide as a handle.
 */
export const EDIT_CANVAS_GUTTER = 16;

/** One pane's dragged width, and the rendering context it was dragged in. */
interface EditWidthRecord {
  /** The tab it belongs to — a record does not survive the pane showing a different document. */
  tabId: string;
  /** `activeMedia` as the drag left it. A disagreement means someone else moved the axis. */
  media: string | null;
  width: number;
}

const _editWidths = new Map<string, EditWidthRecord>();

/** The size breakpoints and base width a tab renders against, site context included. */
function mediaEntriesOfTab(tab: Tab) {
  return parseMediaEntries(
    getEffectiveMedia(tab.doc.document?.$media as Record<string, string> | undefined),
  );
}

/**
 * The width the Size switcher alone would give this column — today's expression, unchanged.
 *
 * A stored breakpoint the document no longer declares falls back to the base width rather than
 * sizing the column from a query that does not exist (`studio.md` §6.2).
 */
export function declaredWidthOfTab(tab: Tab): number {
  const { baseWidth, sizeBreakpoints } = mediaEntriesOfTab(tab);
  const media = tab.session.ui.activeMedia;
  return sizeBreakpoints.find((bp) => bp.name === media)?.width ?? baseWidth;
}

/**
 * This pane's dragged width, or `null` when it has none that still applies.
 *
 * Discards — rather than merely ignores — a record belonging to another tab or written beside
 * another breakpoint, so a stale entry cannot come back to life when the pane returns to that tab.
 */
export function editWidthOfPane(paneId: string, tab: Tab | null): number | null {
  const record = _editWidths.get(paneId);
  if (!record) {
    return null;
  }
  if (!tab || record.tabId !== tab.id || record.media !== tab.session.ui.activeMedia) {
    _editWidths.delete(paneId);
    return null;
  }
  return record.width;
}

/** The width the Edit column should render at: the dragged one, else the switcher's. */
export function resolveEditColumnWidth(surface: CanvasSurface, tab: Tab | null): number {
  const fallback = tab ? declaredWidthOfTab(tab) : 0;
  return editWidthOfPane(surface.paneId, tab) ?? fallback;
}

/** Forget this pane's dragged width — the mode transition's "start at the breakpoint" rule. */
export function clearEditWidth(paneId: string): void {
  _editWidths.delete(paneId);
}

/** Drop every record. Tests only; there is no runtime caller. */
export function resetEditWidths(): void {
  _editWidths.clear();
}

/** The widths a drag is magnetic towards: every declared breakpoint, plus Base. */
export function snapTargetsOfTab(tab: Tab): number[] {
  const { baseWidth, sizeBreakpoints } = mediaEntriesOfTab(tab);
  return [baseWidth, ...sizeBreakpoints.map((bp) => bp.width)];
}

/**
 * Record a width against a pane, and answer the breakpoint it puts the canvas in.
 *
 * The media is stored ALONGSIDE the width because that is what lets the record invalidate itself
 * (see the header): the two are written together here and nowhere else.
 */
export function setEditWidth(paneId: string, tab: Tab, width: number): string | null {
  const { sizeBreakpoints } = mediaEntriesOfTab(tab);
  const media = mediaForWidth(sizeBreakpoints, width);
  tab.session.ui.activeMedia = media;
  _editWidths.set(paneId, { media, tabId: tab.id, width });
  return media;
}
