/// <reference lib="dom" />
/**
 * In-iframe insertion-zone math (cross-origin "+" affordance). Runs INSIDE the canvas iframe, in
 * the iframe's own realm/coords, and is the structural cousin of {@link file://./iframe-drop.ts}:
 * where iframe-drop resolves a DRAG's placement, this resolves where a fresh element could be
 * INSERTED at the gaps around the hovered node, so the parent can float a clickable "+" there.
 *
 * It SALVAGES the pure edge/index math from the orphaned parent-realm
 * {@link file://../editor/insertion-helper.ts} (empty-container detection, row-vs-column layout via
 * getComputedStyle(parent), {@link EDGE_THRESHOLD}, leading/trailing edge → insert index) but
 * re-expresses it against IFRAME-realm rects ({@link rectOf}, stubbable) and the iframe's shadow
 * doc, and reproduces the parent's `parentElementPath`/`childIndex` resolution so the posted
 * `insertParentPath` + `index` feed the unchanged `mutateInsertNode(t, parentPath, index, def)`.
 *
 * PURE: it reads element rects through {@link rectOf} and `data-jx-path`, so it is unit-proven
 * against fake rects. The DOM adapter that resolves the hovered element from a point is CDP-only
 * (happy-dom's `elementFromPoint` returns null) and lives in iframe-interaction.
 */

import { parseJxPath } from "./path-mapping";
import { rectOf } from "../utils/geometry";
import { childIndex, parentElementPath } from "../state";
import type { InsertZone, SerializableRect } from "./iframe-protocol";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../state";

/** Edge detection threshold in pixels (SALVAGED from insertion-helper.ts). */
export const EDGE_THRESHOLD = 14;

/** The CSS class the renderer stamps on an empty container's placeholder (SALVAGED). */
const EMPTY_CONTAINER_CLASS = "empty-container-placeholder";

/** Read an element's iframe-viewport rect as a {@link SerializableRect}. */
function rectFor(el: Element): SerializableRect {
  const r = rectOf(el);
  return { height: r.height, width: r.width, x: r.x, y: r.y };
}

/**
 * Whether the hovered element's parent lays its children out in a ROW (so leading/trailing edges
 * are LEFT/RIGHT rather than TOP/BOTTOM). Ports the legacy direction test: flex `row*` or grid
 * `grid-auto-flow: column*`. Pure-ish — reads getComputedStyle, which the unit test stubs.
 */
function isRowLayout(parent: HTMLElement): boolean {
  const style = getComputedStyle(parent);
  const { display } = style;
  const isFlex = display === "flex" || display === "inline-flex";
  const isGrid = display === "grid" || display === "inline-grid";
  return (
    (isFlex && style.flexDirection.startsWith("row")) ||
    (isGrid && (style.gridAutoFlow ?? "").startsWith("column"))
  );
}

/**
 * Compute the candidate insertion "+" zone(s) for a cursor over `targetEl`, PURE against
 * iframe-realm rects.
 *
 * `cursor` is in iframe-viewport coords (same space as {@link rectOf}); `shadowDoc` is the iframe's
 * non-reactive shadow doc (carried for parity with iframe-drop — the structural decision here needs
 * only the stamped path, but keeping the signature aligned lets the entry thread the same
 * accessor).
 *
 * Branching (SALVAGED from insertion-helper.ts onMouseMove):
 *
 * - Empty container (`empty-container-placeholder` class) → ONE centered zone that inserts as the
 *   container's first child (`insertParentPath = targetPath`, `index = 0`).
 * - Otherwise resolve the parent's layout (row/grid-column vs column); when the cursor is within
 *   {@link EDGE_THRESHOLD} of the leading edge → a sibling-before zone (`index = childIndex`); of
 *   the trailing edge → a sibling-after zone (`index = childIndex + 1`); mid-element → null.
 *
 * Returns null for the root/degenerate cases (no addressable parent to insert a sibling into) and
 * when the cursor is not near an edge.
 */
export function computeInsertZones(
  targetEl: HTMLElement,
  cursor: { x: number; y: number },
  shadowDoc: JxMutableNode,
): InsertZone[] | null {
  void shadowDoc;
  const serialized = targetEl.dataset?.jxPath;
  if (serialized == null) {
    return null;
  }
  const targetPath = parseJxPath(serialized) as JxPath;

  // Empty container: one centered "+" that inserts as the container's first child.
  if (targetEl.classList.contains(EMPTY_CONTAINER_CLASS)) {
    return [{ edge: "center", index: 0, insertParentPath: targetPath, rect: rectFor(targetEl) }];
  }

  // A sibling insert needs an addressable parent element path; the root (path.length < 2) has none.
  const parentPath = parentElementPath(targetPath);
  if (!parentPath) {
    return null;
  }
  const parent = targetEl.parentElement;
  if (!parent) {
    return null;
  }
  const childIdx = childIndex(targetPath);
  if (typeof childIdx !== "number") {
    return null;
  }

  const rect = rectFor(targetEl);
  if (isRowLayout(parent)) {
    const relX = cursor.x - rect.x;
    if (relX < EDGE_THRESHOLD) {
      return [edgeZone("left", parentPath, childIdx, leadingEdgeRect(rect, true))];
    }
    if (rect.width - relX < EDGE_THRESHOLD) {
      return [edgeZone("right", parentPath, childIdx + 1, trailingEdgeRect(rect, true))];
    }
    return null;
  }

  const relY = cursor.y - rect.y;
  if (relY < EDGE_THRESHOLD) {
    return [edgeZone("top", parentPath, childIdx, leadingEdgeRect(rect, false))];
  }
  if (rect.height - relY < EDGE_THRESHOLD) {
    return [edgeZone("bottom", parentPath, childIdx + 1, trailingEdgeRect(rect, false))];
  }
  return null;
}

/** Build a sibling-edge zone. */
function edgeZone(
  edge: InsertZone["edge"],
  insertParentPath: JxPath,
  index: number,
  rect: SerializableRect,
): InsertZone {
  return { edge, index, insertParentPath, rect };
}

/**
 * A zero-thickness anchor rect at the target's LEADING edge — top edge (column) or left edge (row).
 * The parent centers the "+" on this box, so it collapses the relevant dimension to the edge.
 */
function leadingEdgeRect(rect: SerializableRect, row: boolean): SerializableRect {
  return row
    ? { height: rect.height, width: 0, x: rect.x, y: rect.y }
    : { height: 0, width: rect.width, x: rect.x, y: rect.y };
}

/** A zero-thickness anchor rect at the target's TRAILING edge — bottom edge or right edge. */
function trailingEdgeRect(rect: SerializableRect, row: boolean): SerializableRect {
  return row
    ? { height: rect.height, width: 0, x: rect.x + rect.width, y: rect.y }
    : { height: 0, width: rect.width, x: rect.x, y: rect.y + rect.height };
}

/**
 * A stable key for a zone set, so the iframe only re-posts when the affordance actually changes
 * (mirrors the hover de-dupe in startInteraction). Null/empty collapse to a single sentinel.
 */
export function insertZonesKey(zones: InsertZone[] | null): string {
  if (!zones || zones.length === 0) {
    return "none";
  }
  return zones.map((z) => `${z.edge}:${z.insertParentPath.join("/")}:${z.index}`).join("|");
}
