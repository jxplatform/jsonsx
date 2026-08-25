/**
 * Grid-idle.ts — the grid's quiescence registry, and nothing else.
 *
 * A separate module from `grid-view.ts` for one reason: `services/idle.ts` must be able to ASK
 * whether any grid is mid-flight without pulling Tabulator into its import graph. It read the
 * probes from `grid-view.ts` first, and `grid-view.ts` imports `tabulator-tables` at module load —
 * so every test that transitively reached `idle.ts` (which is most of them, through the shell)
 * tried to evaluate the Tabulator ESM bundle and died with `Export named 'ClipboardModule' not
 * found` unless it had thought to mock a module it never uses.
 *
 * So the dependency points the other way: this file imports nothing, `idle.ts` reads it, and
 * `grid-view.ts` writes to it.
 */

/** Answers `null` when its grid is settled, or a human-readable reason when it is not. */
export type GridProbe = () => string | null;

const liveGrids = new Set<GridProbe>();

/** Register a live grid. The returned function deregisters it — call it from `destroy()`. */
export function registerGridProbe(probe: GridProbe): () => void {
  liveGrids.add(probe);
  return () => liveGrids.delete(probe);
}

/**
 * Grids still building, or still laying out their selection range.
 *
 * A probe must never throw: it runs inside the idle predicate, and an exception there would be
 * indistinguishable from a subsystem that never settles.
 */
export function gridIdleBlockers(): readonly string[] {
  const blockers: string[] = [];
  for (const probe of liveGrids) {
    try {
      const reason = probe();
      if (reason) {
        blockers.push(reason);
      }
    } catch {
      // A table torn down between registration and probe is settled by definition.
    }
  }
  return blockers;
}
