/// <reference lib="dom" />
/**
 * Which popover the canvas draws open, and the one rule that decides it from a selection.
 *
 * **Open on selection is one rule, not one per surface.** There is no single WRITER of
 * `session.selection` — the Outline writes it, the canvas writes it, `transact.ts` writes it after
 * a structural edit, quick search and problem-jump write it. There IS a single OBSERVER: the
 * reactive effect the canvas host already runs over every shown pane's selection. So the rule lives
 * beside that, in an effect of its own, and every door into a popover opens it: clicking the panel,
 * clicking a row in the Outline, jumping to a Problem inside it, or arriving there through undo.
 *
 * The rule is deliberately **asymmetric**: selecting at or inside a popover opens it, and selecting
 * outside every popover does NOT close the open one. Closing on any stray selection would make a
 * popover impossible to style — you could not reach a colour swatch in the Inspector without the
 * panel slamming shut under you. Closing is explicit: the action-bar control, or selecting into a
 * different popover.
 *
 * A separate effect from the host's selection watch rather than a line inside it, because that one
 * READS the selection and this one WRITES `ui.openPopover`; folding them together would write to a
 * value inside the effect that tracks it.
 *
 * The path arithmetic lives in `popover-path.ts` — see its header for why the split exists.
 *
 * @docs studio/interface/canvas
 */

import { activeTab } from "../workspace/workspace";
import { ancestorPopoverPath } from "./popover-path";
import { effect } from "../reactivity";
import { postPopoverOpen, revealCanvasPath } from "./iframe-host";
import { primarySelection } from "../tabs/selection";
import { updateSession } from "../store";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../state";
import type { Tab } from "../tabs/tab";

/** Whether two paths address the same node. */
function samePath(a: JxPath | null, b: JxPath | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/**
 * Write `ui.openPopover` and tell every frame showing this tab.
 *
 * The single writer. `canvas.setPopoverOpen`, the reveal rule and the trigger click in the canvas
 * all land here, so the model and the frames cannot disagree about which panel is open.
 *
 * @param tab The tab whose canvas is affected.
 * @param path The popover's path, or null to close whatever is open.
 */
export function setOpenPopover(tab: Tab, path: JxPath | null): void {
  updateSession(tab, { ui: { openPopover: path } });
  postPopoverOpen(tab, path);
}

/** Open the popover containing `path`, if any. Returns whether anything changed. */
function openPopoverFor(tab: Tab, path: JxPath | null): boolean {
  const target = ancestorPopoverPath(tab.doc.document as JxMutableNode, path);
  if (target === null || samePath(tab.session.ui.openPopover, target)) {
    return false;
  }
  setOpenPopover(tab, target);
  return true;
}

/**
 * Reconcile one tab's open popover with its current selection.
 *
 * Only ever OPENS — see the asymmetry argued in this file's header.
 *
 * @param tab The tab to reconcile, or null/undefined for none.
 */
export function reconcileOpenPopover(tab: Tab | null | undefined): void {
  if (tab) {
    openPopoverFor(tab, primarySelection(tab.session.selection));
  }
}

/**
 * Bring `path` into view in the canvas, opening the popover it is inside first.
 *
 * The open message and the subsequent measure travel the same FIFO channel, and
 * `getBoundingClientRect` forces layout synchronously — so the measure inside `revealCanvasPath`
 * already sees the panel laid out. No acknowledgement, no await, no timer.
 *
 * This replaced `panToElement`, which resolved paths by walking the PARENT realm's DOM. The canvas
 * element's children have been `[iframe, overlay]` since the canvas became a cross-origin frame, so
 * that walk returned null for every non-root path: clicking an Outline row had never scrolled the
 * canvas at all.
 *
 * @param path The document path to reveal.
 */
export function revealPathInCanvas(path: JxPath): void {
  const tab = activeTab.value;
  if (tab) {
    openPopoverFor(tab, path);
  }
  void revealCanvasPath(path);
}

/** The live reveal watch, or null when none is running. Module-local so a second start is a no-op. */
let watching: { stop: () => void } | null = null;

/**
 * Start the reveal watch. Idempotent, like the host's own watches.
 *
 * @returns A stop function, for teardown and for tests.
 */
export function ensurePopoverRevealWatch(): () => void {
  if (!watching) {
    const runner = effect(() => {
      reconcileOpenPopover(activeTab.value);
    });
    watching = {
      stop: () => {
        runner.effect.stop();
      },
    };
  }
  const held = watching;
  return () => {
    held.stop();
    if (watching === held) {
      watching = null;
    }
  };
}
