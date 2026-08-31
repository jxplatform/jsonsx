/// <reference lib="dom" />
/**
 * Which popover a document path belongs to — the pure half of the open-on-selection rule.
 *
 * Separate from `popover-state.ts` because of who needs it. The command record in `canvas-utils.ts`
 * has to answer "is there a popover here?" for its `enablement`, and `popover-state.ts` reaches
 * `iframe-host.ts`, which reaches `canvas-utils.ts` — so importing the whole rule from the command
 * file would close a cycle. Nothing here touches a frame, a channel or the DOM, which is also what
 * makes it the easy half to test.
 *
 * @docs studio/interface/canvas
 */

import { activeTab } from "../workspace/workspace";
import { getNodeAtPath } from "../state";
import { documentHasPopover, isPopover } from "@jxsuite/schema/overlays";
import { primarySelection } from "../tabs/selection";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../state";
import type { Tab } from "../tabs/tab";

/**
 * The nearest ancestor-or-self of `path` that declares `popover`, or null when there is none.
 *
 * Walks prefixes of the path rather than the tree, so it costs one `getNodeAtPath` per level and
 * needs no parent pointers. A prefix that lands on a non-node (the `"children"` segment itself, an
 * index into a repeater's `items`) simply is not a popover, so nothing here has to enumerate the
 * segment vocabulary — which is what keeps it correct across `map` and `cases` hops for free.
 *
 * @param doc The document the path addresses.
 * @param path The selected node's path.
 * @returns The popover's path, or null.
 */
export function ancestorPopoverPath(
  doc: JxMutableNode | null | undefined,
  path: JxPath | null | undefined,
): JxPath | null {
  if (!doc || !path) {
    return null;
  }
  for (let end = path.length; end >= 0; end -= 1) {
    const prefix = path.slice(0, end);
    const node = getNodeAtPath(doc, prefix);
    if (node && typeof node === "object" && isPopover(node)) {
      return prefix;
    }
  }
  return null;
}

/**
 * The popover a `canvas.setPopoverOpen` call means for `tab`, or null when there is none.
 *
 * An explicit `path` is taken at its word but still CHECKED — the palette, the assistant and the
 * automation runner all reach the command, and a path that is not a popover must be refused rather
 * than silently opening nothing. With no argument the answer is the popover the SELECTION is at or
 * inside, which is what makes the command usable from a keystroke with nothing else stated.
 *
 * Takes the tab rather than reading the active one, so the command's `pane` argument decides which
 * document is consulted: a split view can have a different popover open in each pane's tab.
 *
 * @param tab The tab to resolve against.
 * @param explicit A path supplied by the caller, if any.
 * @returns The popover's path, or null.
 */
export function popoverPathFor(tab: Tab, explicit?: JxPath): JxPath | null {
  const doc = tab.doc.document as JxMutableNode | undefined;
  if (!doc) {
    return null;
  }
  if (explicit) {
    const node = getNodeAtPath(doc, explicit);
    return node && typeof node === "object" && isPopover(node) ? explicit : null;
  }
  return ancestorPopoverPath(doc, primarySelection(tab.session.selection));
}

/**
 * Whether the focused document has any popover — what the command's `enablement` asks.
 *
 * A fact about the DOCUMENT, not about the selection. Gating on the selection looked tighter and
 * was wrong: the palette, the assistant and a screenshot step all name a popover by path, and an
 * enablement predicate cannot see the arguments, so it would have refused every one of them before
 * the path was read. The specific refusal — "that path is not a popover" — belongs to the run,
 * where the argument exists.
 *
 * Reading the focused tab is correct here and only here: enablement describes what would happen if
 * you pressed Enter now, and that is the pane you are in. The command's `run` resolves its tab
 * through `contextTab` instead, so a `pane` argument still decides the write. That split is why
 * this lives here rather than in `canvas-utils.ts`, whose stage-geometry functions must never read
 * the focused tab (`check-pane-singletons.ts` enforces it).
 *
 * @returns True when the focused document declares at least one popover.
 */
export function activeDocumentHasPopover(): boolean {
  const doc = activeTab.value?.doc.document as JxMutableNode | undefined;
  return doc ? documentHasPopover(doc) : false;
}
