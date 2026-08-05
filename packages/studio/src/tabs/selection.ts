/**
 * The selection SET — one vocabulary for `session.selection`, now that it is `JxPath[]` (§6.5).
 *
 * ## The invariant this module exists to hold
 *
 * **A selection of one behaves exactly as a selection did before it was a list.** Every surface
 * that addresses a single node — the Inspector's three tabs, the block action bar, the status bar,
 * the canvas overlay box, the context menu — reads {@link primarySelection} and nothing else. When
 * `length === 1` that function returns the sole path, so those surfaces receive byte-identically
 * what `session.selection` used to hand them. Nothing downstream of `primarySelection` can tell the
 * difference, and that is what makes the widening shippable: the multi cases are additions beside
 * the single case, never a rewrite of it.
 *
 * The corollary is a rule about writes: **replace the array, never mutate it in place.** Several
 * render effects track the selection with a bare `void tab.session.selection` read, which
 * subscribes to the property and not to the array's indices; an in-place `push` would move the
 * selection without repainting the panel that draws it. Every helper here returns a NEW array.
 *
 * ## Ordering, and why two ends of the list have names
 *
 * The list is kept in the order the user built it.
 *
 * - {@link selectionAnchor} is `selection[0]` — where a shift-range extends FROM. It survives every
 *   range extension, so shift-clicking A then D then B gives A..D then A..B, which is what every
 *   list in every file manager does.
 * - {@link primarySelection} is the LAST element — the most recently added path, and therefore the
 *   one the user just pointed at. Single-target surfaces address it.
 *
 * ## Structural batches
 *
 * A multi-node structural edit is one decision and must be one undo step, which `transactDoc`
 * already gives for free — everything mutated inside one call is one history entry. What it does
 * NOT give is index safety: removing `children/0` renumbers `children/1`, so a naive loop over the
 * selection deletes the wrong nodes. {@link structuralBatch} answers that once — descendants
 * dropped, then descending document order, so every splice happens below coordinates nothing later
 * in the batch depends on.
 *
 * It also answers a second question the single-path world never had to ask: whether a selected path
 * is a splice coordinate AT ALL. The Outline gives the document element, a repeater's map template
 * and a `$switch` case rows of their own, and any of them can be ctrl-clicked into a selection
 * beside an ordinary element. {@link isSpliceablePath} is the test, and it is the one thing
 * standing between a mixed selection and a half-applied, unrecorded delete.
 */

import type { JxPath } from "../state";
import { isAncestor, pathsEqual } from "../state";

/**
 * The path single-target surfaces address — the most recently added, or `null` when empty.
 *
 * @param {readonly JxPath[] | null | undefined} selection
 * @returns {JxPath | null}
 */
export function primarySelection(selection: readonly JxPath[] | null | undefined): JxPath | null {
  return selection && selection.length > 0 ? (selection.at(-1) as JxPath) : null;
}

/**
 * The path a shift-range extends from — the first in the list, or `null` when empty.
 *
 * @param {readonly JxPath[] | null | undefined} selection
 * @returns {JxPath | null}
 */
export function selectionAnchor(selection: readonly JxPath[] | null | undefined): JxPath | null {
  return selection && selection.length > 0 ? (selection[0] as JxPath) : null;
}

/**
 * Whether `path` is one of the selected paths.
 *
 * @param {readonly JxPath[] | null | undefined} selection
 * @param {JxPath | null} path
 * @returns {boolean}
 */
export function isSelected(
  selection: readonly JxPath[] | null | undefined,
  path: JxPath | null,
): boolean {
  if (!path || !selection) {
    return false;
  }
  return selection.some((p) => pathsEqual(p, path));
}

/**
 * Copy a selection, so nothing can mutate one through the array it was handed.
 *
 * History entries, sub-document frames and the collab awareness payload all take a copy for the
 * same reason they always did: `session.selection` is a reactive proxy, and a stored reference to
 * it would follow the live selection instead of recording where it was.
 *
 * @param {readonly JxPath[]} paths
 * @returns {JxPath[]}
 */
export function cloneSelection(paths: readonly JxPath[]): JxPath[] {
  return clonePaths(paths);
}

/** Copy a list of paths, so no caller can mutate a selection through the array it was handed. */
function clonePaths(paths: readonly JxPath[]): JxPath[] {
  const out: JxPath[] = [];
  for (const path of paths) {
    out.push([...path]);
  }
  return out;
}

/**
 * Ctrl/Cmd-click: add the path when it is absent, remove it when it is present.
 *
 * Adding appends, so the newly clicked path becomes the primary and the anchor is untouched.
 * Removing preserves the order of the survivors — including the anchor, unless the anchor is what
 * was removed.
 *
 * @param {readonly JxPath[]} selection
 * @param {JxPath} path
 * @returns {JxPath[]}
 */
export function toggleSelected(selection: readonly JxPath[], path: JxPath): JxPath[] {
  if (isSelected(selection, path)) {
    return clonePaths(selection.filter((p) => !pathsEqual(p, path)));
  }
  return [...clonePaths(selection), [...path]];
}

/**
 * Shift-click: the contiguous run of `rows` between the anchor and `target`, inclusive.
 *
 * `rows` is the surface's own visible order — the Outline's flattened, expansion-aware row list —
 * because "the range between these two" is a question only the surface that draws them can answer.
 * When the anchor is absent from `rows` (it was collapsed away, or nothing was selected) the range
 * degenerates to `[target]`, which is a plain click.
 *
 * The returned list starts at the anchor end, so the anchor stays `selection[0]` and the target
 * becomes the primary — a further shift-click re-extends from the same anchor.
 *
 * @param {readonly JxPath[]} rows Visible rows in display order.
 * @param {JxPath | null} anchor
 * @param {JxPath} target
 * @returns {JxPath[]}
 */
export function rangeSelection(
  rows: readonly JxPath[],
  anchor: JxPath | null,
  target: JxPath,
): JxPath[] {
  const to = rows.findIndex((p) => pathsEqual(p, target));
  const from = anchor ? rows.findIndex((p) => pathsEqual(p, anchor)) : -1;
  if (to === -1 || from === -1) {
    return [[...target]];
  }
  const slice = from <= to ? rows.slice(from, to + 1) : rows.slice(to, from + 1).toReversed();
  return clonePaths(slice);
}

/**
 * Drop every selected path that `removed` addresses or contains.
 *
 * This is `mutateRemoveNode`'s selection repair, widened: deleting a node used to clear the
 * selection outright, and with a list it clears only the entries the deletion actually invalidated.
 * A one-path selection therefore still ends up empty exactly when it used to.
 *
 * @param {readonly JxPath[]} selection
 * @param {JxPath} removed
 * @returns {JxPath[]}
 */
export function pruneSelection(selection: readonly JxPath[], removed: JxPath): JxPath[] {
  return clonePaths(selection.filter((p) => !isAncestor(removed, p)));
}

/**
 * Order two paths the way the document reads: parents before children, siblings by index.
 *
 * Segments are compared pairwise; numbers numerically (so `children/10` follows `children/9`), and
 * anything else by string order. A prefix sorts before what extends it.
 *
 * @param {JxPath} a
 * @param {JxPath} b
 * @returns {number}
 */
export function comparePaths(a: JxPath, b: JxPath): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) {
      continue;
    }
    if (typeof x === "number" && typeof y === "number") {
      return x - y;
    }
    return String(x) < String(y) ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Drop any path whose ancestor is also selected.
 *
 * Deleting a `<section>` and one of its own paragraphs is one deletion, not two: the paragraph goes
 * with its parent, and a second splice into coordinates that no longer exist is how a batch
 * corrupts a document.
 *
 * @param {readonly JxPath[]} selection
 * @returns {JxPath[]}
 */
export function topLevelSelection(selection: readonly JxPath[]): JxPath[] {
  return clonePaths(
    selection.filter((p) => !selection.some((q) => !pathsEqual(q, p) && isAncestor(q, p))),
  );
}

/**
 * Whether `path` names a position a structural verb can splice — a tail of `"children"` + index.
 *
 * Every structural mutator (`mutateRemoveNode`, `mutateDuplicateNode`, `mutateWrapNode`) reaches
 * its parent with `parentElementPath` — drop the last two segments — and its position with
 * `childIndex` — take the last. That produces a splice coordinate for exactly one path shape, and
 * the Outline emits three others as first-class rows: the document element (`[]`), a repeater's map
 * template (`[…, "children", 1, "map"]`) and a `$switch` case (`[…, "cases", "warn"]`). For the
 * template, `parentElementPath` resolves to the enclosing children ARRAY, whose `.children` is
 * `undefined`, so the splice throws mid-transaction; for a case it splices at `NaN` and takes the
 * wrong child.
 *
 * Selecting one of those beside an ordinary element is a single ctrl-click, so this is the
 * invariant that keeps a batch from mutating the document and then throwing before anything is
 * recorded.
 *
 * @param {JxPath} path
 * @returns {boolean}
 */
export function isSpliceablePath(path: JxPath): boolean {
  return path.at(-2) === "children" && typeof path.at(-1) === "number";
}

/**
 * The order a structural batch must run in: contained paths dropped, unspliceable paths dropped,
 * then LAST node first.
 *
 * Descending document order is what makes a loop of splices safe. Removing or duplicating at index
 * `n` renumbers every sibling after `n`, so a batch that starts at the end never touches a
 * coordinate a later step still needs. It is also why duplicating a multi-selection inserts each
 * clone directly after its own original instead of walking the whole run forward.
 *
 * Containment is decided BEFORE spliceability, on the selection the user actually made: a selected
 * repeater template still shadows its own descendants, so selecting the template and something
 * inside it yields nothing rather than quietly deleting the child the user never pointed at.
 *
 * @param {readonly JxPath[]} selection
 * @returns {JxPath[]} Deepest/last first, every entry a splice coordinate.
 */
export function structuralBatch(selection: readonly JxPath[]): JxPath[] {
  return topLevelSelection(selection)
    .filter((path) => isSpliceablePath(path))
    .toSorted((a, b) => comparePaths(b, a));
}

/**
 * Deduplicate a list of paths, keeping the FIRST occurrence of each.
 *
 * Keeping the first is what makes `selection.setPaths` idempotent: passing the same list twice — or
 * a list that names one node twice — always lands on the same selection, in the same order, with
 * the same anchor and the same primary.
 *
 * @param {readonly JxPath[]} paths
 * @returns {JxPath[]}
 */
export function uniquePaths(paths: readonly JxPath[]): JxPath[] {
  const out: JxPath[] = [];
  for (const path of paths) {
    if (!out.some((p) => pathsEqual(p, path))) {
      out.push([...path]);
    }
  }
  return out;
}

/**
 * Whether two selections name the same paths in the same order.
 *
 * @param {readonly JxPath[] | null | undefined} a
 * @param {readonly JxPath[] | null | undefined} b
 * @returns {boolean}
 */
export function selectionsEqual(
  a: readonly JxPath[] | null | undefined,
  b: readonly JxPath[] | null | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((p, i) => pathsEqual(p, y[i] as JxPath));
}

/**
 * Collapse one field's value across the selection into a single reading.
 *
 * `{ mixed: true }` is the answer the three inspector tabs render as the **Mixed** provenance
 * state: the selected nodes disagree, so there is no one value to show and typing one would
 * overwrite several different ones. `{ mixed: false, value }` is the answer when they agree — and
 * when the selection is a single node it is ALWAYS that answer, which is why a single selection
 * renders no Mixed state anywhere.
 *
 * Comparison is by JSON shape rather than reference: two nodes that both carry `{ $ref: "#/state/x"
 * }` hold equal values written at different times.
 *
 * @template T
 * @param {readonly T[]} values One per selected node, in selection order.
 * @returns {{ mixed: boolean; value: T | undefined }}
 */
export function unifyValues<T>(values: readonly T[]): { mixed: boolean; value: T | undefined } {
  if (values.length === 0) {
    return { mixed: false, value: undefined };
  }
  const first = values[0] as T;
  const key = JSON.stringify(first ?? null);
  for (let i = 1; i < values.length; i++) {
    if (JSON.stringify(values[i] ?? null) !== key) {
      return { mixed: true, value: undefined };
    }
  }
  return { mixed: false, value: first };
}
