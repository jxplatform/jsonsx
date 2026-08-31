/**
 * A diff pane's review state: the comparison's change map, and where in it the author is.
 *
 * **The store is a module-local `Map` keyed by pane**, the shape `_editWidths` in `edit-width.ts`
 * and `_fits` in `canvas-utils.ts` already use. The value is transient — it is rebuilt by the
 * render pass that computes the comparison — and its only readers are that pass, the stepper and
 * the diff header, so a field on `CanvasSurface` would buy nothing and a field on `shell` would be
 * an app-level slot for a per-pane fact, which is exactly the defect the Diff LENS was built to
 * avoid (`workspace/pane-derive.ts`, finding 4: one app-level `diffState` meant two panes drew one
 * comparison).
 *
 * **Keyed by PANE, because two panes can compare two different files at once** — the Source Control
 * panel's diff in the primary and a Diff lens beside it — and because a lens must never write the
 * source tab's `session.ui`. `canvasModeOfPane` and `derivationOfPane` are keyed the same way for
 * the same reason.
 *
 * **This file is a LEAF.** It imports one type and nothing else, so the render pass, the stepper
 * and the header can all reach it without any of them reaching each other.
 */

import type { ChangeMap } from "./diff-marks";

/** Which half of a comparison a pane is showing. */
export type DiffView = "visual" | "code";

interface DiffRecord {
  map: ChangeMap | null;
  /** Index into `map.steps`, or -1 for "arrived, not yet stepping". */
  step: number;
  view: DiffView;
}

const _records = new Map<string, DiffRecord>();

function recordFor(paneId: string): DiffRecord {
  const existing = _records.get(paneId);
  if (existing) {
    return existing;
  }
  const fresh: DiffRecord = { map: null, step: -1, view: "visual" };
  _records.set(paneId, fresh);
  return fresh;
}

/**
 * Record the comparison this pane's render just computed.
 *
 * **The cursor is CLAMPED rather than reset**, and that is the difference between a review loop
 * somebody uses and one they abandon. Every save re-reads the comparison and rebuilds the map, so
 * resetting here would send an author who fixed change 7 of 12 back to change 1 each time they hit
 * ⌘S. Clamping keeps them where they were unless the list actually got shorter than their
 * position.
 */
export function setDiffChangeMap(paneId: string, map: ChangeMap | null): void {
  const record = recordFor(paneId);
  record.map = map;
  const total = map?.steps.length ?? 0;
  record.step = total === 0 ? -1 : Math.min(record.step, total - 1);
}

/** This pane's comparison, or null when none has been computed (or it could not be). */
export function diffChangeMapOf(paneId: string): ChangeMap | null {
  return _records.get(paneId)?.map ?? null;
}

/** How many changes this pane's comparison found. */
export function diffChangeCount(paneId: string): number {
  return _records.get(paneId)?.map?.steps.length ?? 0;
}

/** Where the author is in the list: 0-based, or -1 before the first step. */
export function diffStepOf(paneId: string): number {
  return _records.get(paneId)?.step ?? -1;
}

/**
 * Move the cursor and answer where it landed, or null when there is nowhere to go.
 *
 * **Stops at the ends rather than wrapping.** A tab strip is a ring with no ends, so `document
 * .nextTab` cycles; a change list is a document read top to bottom, and wrapping past the last
 * change silently returns a reviewer to part of the page they have already cleared. The header
 * disables the button that cannot move and says which end it is at.
 */
export function stepDiff(paneId: string, delta: 1 | -1): number | null {
  const record = _records.get(paneId);
  const total = record?.map?.steps.length ?? 0;
  if (!record || total === 0) {
    return null;
  }
  // From -1 a forward step lands on 0 and a backward step on the last change, so either chord
  // Enters the list from the end it is aimed at rather than refusing on arrival.
  const next = record.step === -1 ? (delta === 1 ? 0 : total - 1) : record.step + delta;
  if (next < 0 || next >= total) {
    return null;
  }
  record.step = next;
  return next;
}

/** Which half of the comparison this pane is showing. */
export function diffViewOf(paneId: string): DiffView {
  return _records.get(paneId)?.view ?? "visual";
}

/**
 * Show the visual comparison or the code one.
 *
 * The caller pairs this with a repaint: the store is deliberately not reactive (its writers are a
 * render pass and a toolbar click, both of which already know to redraw), so nothing observes it.
 */
export function setDiffView(paneId: string, view: DiffView): void {
  recordFor(paneId).view = view;
}

/** Drop this pane's review state — called from the stage teardown, beside `clearEditWidth`. */
export function clearDiffView(paneId: string): void {
  _records.delete(paneId);
}

/** Drop every record. Tests only; there is no runtime caller. */
export function resetDiffViews(): void {
  _records.clear();
}
