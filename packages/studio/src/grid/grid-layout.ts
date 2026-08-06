/**
 * Grid view state — column layout, filter, sort, grouping — and the NAMED views that snapshot it.
 *
 * One store, not two. Column widths and order have persisted per grid id in `localStorage` since
 * the grid shipped; a saved view is the same record with three more facets and a name, written to
 * the same key. The alternative — a second `jx-grid-views:` store beside this one — is how a grid
 * ends up with a column order that a view cannot capture and a view that a resize does not update,
 * which is the class of bug plan §12 P7.2 asks this item to avoid by construction.
 *
 * **The working layout is the truth; a view is a copy of it.** Every control writes the working
 * layout (`saveGridLayout`), so a grid remembers how you left it whether or not you ever name a
 * view. {@link saveViewAs} copies the working layout under a name; {@link applySavedView} copies it
 * back and records which name is applied. That is why {@link activeViewModified} can answer
 * honestly — the applied name is a bookmark, not a mode, and a resize after applying one leaves the
 * two legitimately different rather than silently rewriting the view.
 *
 * **Per collection, for free.** The key is the grid id, and a grid id IS
 * `makeGridTabId({kind:"collection", name})` for a collection, the file path for a CSV, and
 * `grid://redirects` for the redirect table. Nothing here knows what a collection is.
 *
 * Pure besides the storage read/write. {@link applyGridLayout} returns a new column-def array with
 * saved widths applied, hidden fields withheld, and saved order first (columns unknown to the saved
 * layout keep their relative position at the end; saved fields that no longer exist are ignored —
 * schemas drift).
 */

/** One sort, as a saved view records it. The grid is single-key sorted; a second key is not saved. */
export interface GridSortSpec {
  field: string;
  dir: "asc" | "desc";
}

/**
 * The view state of one grid.
 *
 * Every field is optional and `undefined` means "leave this facet alone" on the way into
 * {@link saveGridLayout}. `sort` and `groupBy` clear with an explicit `null`, because "no sort" is a
 * choice a view must be able to record and `undefined` already means something else.
 */
export interface GridLayout {
  /** Column order as field names, leftmost first. */
  order?: string[];
  /** Field → width in px. */
  widths?: Record<string, number>;
  /** Fields withheld from the table. The DATA still loads — only the column is not drawn. */
  hidden?: string[];
  /** Row order, applied by the controller (see `grid-controller.ts`), or null for source order. */
  sort?: GridSortSpec | null;
  /** Field whose value gathers rows into contiguous groups, or null for ungrouped. */
  groupBy?: string | null;
  /** The toolbar's text filter. */
  filter?: string;
}

/** A named snapshot of {@link GridLayout}. The name is its identity within one grid. */
export interface SavedGridView extends GridLayout {
  name: string;
}

/** What one grid id holds in storage: its working layout, its named views, and which one is on. */
interface GridLayoutRecord extends GridLayout {
  views?: SavedGridView[];
  active?: string | null;
}

/** The facets a view captures, in a fixed order — the comparison and the copy both walk this. */
const FACETS = ["order", "widths", "hidden", "sort", "groupBy", "filter"] as const;

const STORAGE_PREFIX = "jx-grid-layout:";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // Storage disabled (privacy mode) — layouts just don't persist.
  }
}

/** The whole stored record for a grid id, or null. */
function readRecord(gridId: string): GridLayoutRecord | null {
  const raw = storage()?.getItem(STORAGE_PREFIX + gridId);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as GridLayoutRecord;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecord(gridId: string, record: GridLayoutRecord): void {
  storage()?.setItem(STORAGE_PREFIX + gridId, JSON.stringify(record));
}

/** Just the view-state facets of a record — what a view copies and what a comparison compares. */
function facetsOf(source: GridLayout): GridLayout {
  const out: GridLayout = {};
  for (const facet of FACETS) {
    if (source[facet] !== undefined) {
      Object.assign(out, { [facet]: source[facet] });
    }
  }
  return out;
}

/** Comparable rendering of a layout's facets — key order is fixed by {@link FACETS}. */
function facetKey(layout: GridLayout): string {
  return JSON.stringify(FACETS.map((facet) => layout[facet] ?? null));
}

/** The working layout for a grid id, or null when nothing is stored. */
export function loadGridLayout(gridId: string): GridLayout | null {
  const record = readRecord(gridId);
  return record ? facetsOf(record) : null;
}

/**
 * Merge a partial view-state change into the working layout for a grid id.
 *
 * Widths MERGE (one column resize must not forget the other nine); every other facet is replaced
 * when present. Named views and the active name are untouched.
 */
export function saveGridLayout(gridId: string, change: GridLayout): void {
  const store = storage();
  if (!store) {
    return;
  }
  const record = readRecord(gridId) ?? {};
  const next: GridLayoutRecord = { ...record, widths: { ...record.widths, ...change.widths } };
  for (const facet of FACETS) {
    if (facet !== "widths" && change[facet] !== undefined) {
      Object.assign(next, { [facet]: change[facet] });
    }
  }
  writeRecord(gridId, next);
}

/** Drop everything stored for a grid id — working layout AND its named views. */
export function clearGridLayout(gridId: string): void {
  storage()?.removeItem(STORAGE_PREFIX + gridId);
}

/**
 * Drop the working layout, keeping the named views.
 *
 * The "Reset" verb. Deleting the views too would make Reset a destructive action wearing the label
 * of a harmless one — the author asked to see the grid as it comes, not to lose four saved views.
 */
export function resetGridLayout(gridId: string): void {
  const record = readRecord(gridId);
  if (!record) {
    return;
  }
  writeRecord(gridId, { active: null, ...(record.views ? { views: record.views } : {}) });
}

// ─── Named views ──────────────────────────────────────────────────────────────

/** The named views for a grid id, in save order. */
export function listSavedViews(gridId: string): SavedGridView[] {
  const views = readRecord(gridId)?.views;
  return Array.isArray(views) ? views.filter((view) => typeof view?.name === "string") : [];
}

/** The name of the view last applied to this grid, or null when the layout is unnamed. */
export function activeViewName(gridId: string): string | null {
  return readRecord(gridId)?.active ?? null;
}

/**
 * Whether the working layout has drifted from the view whose name it carries.
 *
 * False when no view is applied — an unnamed layout cannot be modified relative to anything. This
 * is what lets the toolbar print "Recent posts •" instead of pretending the applied view already
 * holds a column the author has since hidden.
 */
export function activeViewModified(gridId: string): boolean {
  const record = readRecord(gridId);
  const name = record?.active;
  if (!record || !name) {
    return false;
  }
  const view = listSavedViews(gridId).find((candidate) => candidate.name === name);
  return view ? facetKey(facetsOf(view)) !== facetKey(facetsOf(record)) : false;
}

/**
 * Snapshot the working layout under a name, replacing a view of the same name.
 *
 * Replacing rather than refusing is what makes this both "Save as…" and "Update": the author who
 * types an existing name means the second one, and a confirmation for overwriting a view you can
 * re-save in one click is chrome for its own sake. Returns null when the name is blank or storage
 * is unavailable — the caller has nothing to select and must not pretend otherwise.
 */
export function saveViewAs(gridId: string, name: string): SavedGridView | null {
  const trimmed = name.trim();
  const store = storage();
  if (trimmed === "" || !store) {
    return null;
  }
  const record = readRecord(gridId) ?? {};
  const view: SavedGridView = { name: trimmed, ...facetsOf(record) };
  const views = listSavedViews(gridId).filter((candidate) => candidate.name !== trimmed);
  views.push(view);
  writeRecord(gridId, { ...record, active: trimmed, views });
  return view;
}

/**
 * Copy a named view onto the working layout and record it as active.
 *
 * Returns the applied layout so the caller can drive the surfaces (the engine remount, the sort,
 * the grouping) from one value, or null when no view of that name exists.
 */
export function applySavedView(gridId: string, name: string): GridLayout | null {
  const view = listSavedViews(gridId).find((candidate) => candidate.name === name);
  if (!view || !storage()) {
    return null;
  }
  const record = readRecord(gridId) ?? {};
  const layout = facetsOf(view);
  writeRecord(gridId, { active: view.name, views: record.views ?? [], ...layout });
  return layout;
}

/**
 * Delete a named view. Clears the active name when it was the one deleted. Returns whether it was
 * there.
 */
export function deleteSavedView(gridId: string, name: string): boolean {
  const record = readRecord(gridId);
  if (!record || !storage()) {
    return false;
  }
  const views = listSavedViews(gridId);
  const kept = views.filter((candidate) => candidate.name !== name);
  if (kept.length === views.length) {
    return false;
  }
  writeRecord(gridId, {
    ...record,
    active: record.active === name ? null : (record.active ?? null),
    views: kept,
  });
  return true;
}

// ─── Applying a layout to column definitions ──────────────────────────────────

/**
 * Apply a saved layout to column defs: hidden fields are withheld, saved widths win, saved order
 * leads and unknowns follow.
 *
 * Hidden columns are DROPPED rather than flagged, because the engine wrapper is the only consumer
 * and a column it never receives is one it cannot draw, size or move. The row objects still carry
 * every field, so the toolbar's text filter — which reads the controller's columns, not these defs
 * — keeps matching on a hidden column's value.
 */
export function applyGridLayout<
  T extends { field?: string | undefined; width?: number | undefined },
>(defs: T[], layout: GridLayout | null): T[] {
  if (!layout) {
    return defs;
  }
  const hidden = new Set(layout.hidden);
  const widened: T[] = [];
  for (const def of defs) {
    if (def.field !== undefined && hidden.has(def.field)) {
      continue;
    }
    const width = def.field ? layout.widths?.[def.field] : undefined;
    widened.push(width ? { ...def, width } : def);
  }
  if (!layout.order?.length) {
    return widened;
  }
  const rank = new Map(layout.order.map((field, i) => [field, i]));
  return widened
    .map((def, index) => ({ def, index }))
    .toSorted((a, b) => {
      const ra = rank.get(a.def.field ?? "") ?? layout.order!.length + a.index;
      const rb = rank.get(b.def.field ?? "") ?? layout.order!.length + b.index;
      return ra - rb;
    })
    .map(({ def }) => def);
}
