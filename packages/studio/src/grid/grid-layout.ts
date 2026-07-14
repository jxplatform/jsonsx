/**
 * Grid column-layout persistence — widths and order, per grid id, in localStorage.
 *
 * Pure besides the storage read/write: applyGridLayout reorders/undoes nothing destructive, it just
 * returns a new column-def array with saved widths applied and saved order first (columns unknown
 * to the saved layout keep their relative position at the end; saved fields that no longer exist
 * are ignored — schemas drift).
 */

export interface GridLayout {
  /** Column order as field names, leftmost first. */
  order?: string[];
  /** Field → width in px. */
  widths?: Record<string, number>;
}

const STORAGE_PREFIX = "jx-grid-layout:";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // Storage disabled (privacy mode) — layouts just don't persist.
  }
}

/** The saved layout for a grid id, or null. */
export function loadGridLayout(gridId: string): GridLayout | null {
  const raw = storage()?.getItem(STORAGE_PREFIX + gridId);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as GridLayout;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge a partial layout change into the saved layout for a grid id. */
export function saveGridLayout(gridId: string, change: GridLayout): void {
  const store = storage();
  if (!store) {
    return;
  }
  const current = loadGridLayout(gridId) ?? {};
  const next: GridLayout = {
    ...((change.order ?? current.order) ? { order: change.order ?? current.order } : {}),
    widths: { ...current.widths, ...change.widths },
  };
  store.setItem(STORAGE_PREFIX + gridId, JSON.stringify(next));
}

/** Drop the saved layout for a grid id. */
export function clearGridLayout(gridId: string): void {
  storage()?.removeItem(STORAGE_PREFIX + gridId);
}

/** Apply a saved layout to column defs: saved widths win; saved order leads, unknowns follow. */
export function applyGridLayout<
  T extends { field?: string | undefined; width?: number | undefined },
>(defs: T[], layout: GridLayout | null): T[] {
  if (!layout) {
    return defs;
  }
  const widened = defs.map((def) => {
    const width = def.field ? layout.widths?.[def.field] : undefined;
    return width ? { ...def, width } : def;
  });
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
