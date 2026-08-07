/// <reference lib="dom" />
/**
 * The surface REGISTRY — one stage record per pane, and nothing that knows what a pane contains.
 *
 * A pane is the unit of split, focus and zoom (§4.1), so it is also the unit of RENDER. The panels
 * a pass mounted, the host element they mounted into, the mode that pass was drawn in and the full
 * render a failed patch escalates to are all facts about ONE pane; they were app-level singletons
 * only because the shell had a single stage.
 *
 * They could not stay that way. `classifyOps` gated a patch on `canvasPanels.every(p => p.ready)`
 * and on one `getCanvasMode()`, and `escalateToFullRender` scheduled the one global render — so the
 * moment a second stage exists, an edit typed into one pane would be refused because the OTHER
 * pane's canvas was still mounting, and every escalation would re-render both. That is a
 * correctness bug, not a performance one, which is why this lands before the second host rather
 * than with it.
 *
 * A surface is addressed by pane id and nothing else. `panels/pane-grid.ts` builds a cell per pane
 * and registers its stage as it goes.
 *
 * **Split from `canvas-surface.ts` for one reason: the WORKSPACE.** The helpers that answer "which
 * tab is this pane showing" need `workspace/workspace.ts`, and `workspace.ts` needs
 * `services/monaco-buffer.ts` — which in turn has to enumerate every stage's source buffer, because
 * a close gate that asked only "the" Monaco would miss whichever pane it was not holding. That is a
 * cycle. The store of records has no opinion about tabs, so it is the half that comes out.
 */

import type { CanvasPanel } from "../types";
import type { MonacoSurface } from "../view";

/**
 * The class name every pane's stage element carries.
 *
 * Declared here rather than in the grid because it is what the two genuinely document-level
 * gestures test with `closest()` — "is this event over SOME stage" is a question about surfaces,
 * not about the reconciler that happens to build them.
 */
export const STAGE_CLASS = "pane-stage";

/** One pane's stage: where it renders, what it mounted there, and what it last drew. */
export interface CanvasSurface {
  /** The pane this stage belongs to. Stable for the life of the pane. */
  readonly paneId: string;
  /**
   * The element the pane's stage renders into.
   *
   * Typed non-null and initialised null, exactly as the shell refs in `store.ts` are: a surface is
   * addressable before its host exists in the DOM, and every renderer runs after `initShellRefs`.
   */
  wrap: HTMLElement;
  /** The panels the last pass mounted here. Mutated in place by the render, never reassigned. */
  readonly panels: CanvasPanel[];
  /**
   * The effective canvas mode this stage last drew, or null before its first pass.
   *
   * Per-surface because it decides a TEARDOWN: a mode transition rebuilds the panel structure, and
   * one pane switching from Design to Code must not make the other pane's next pass believe its own
   * structure is stale.
   */
  prevCanvasMode: string | null;
  /**
   * The transformed element the pan/zoom modes draw into, or null in the modes that render none.
   *
   * Per-surface because it IS the stage's content. `view.panzoomWrap` held whichever pane painted
   * last, so a fit computed for one pane wrote a transform onto the other's artboards.
   */
  panzoomWrap: HTMLElement | null;
  /** The observer that re-centres this stage until the author pans it. One per stage. */
  centerObserver: ResizeObserver | null;
  /** Whether this stage still wants re-centring — cleared by the first deliberate pan. */
  needsCenter: boolean;
  panX: number;
  panY: number;
  /** The source view's Monaco, mounted into THIS stage. Two Code panes are two models. */
  monacoEditor: MonacoSurface | null;
  /** Teardown for this stage's source-mode collab binding (unbind + release the lock). */
  sourceCollabCleanup: (() => void) | null;
  /**
   * The generation of the last render pass this stage opened.
   *
   * Per-surface because it is a STALENESS comparison within one pane: a deferred artboard asks "is
   * the pass I belong to still the current one HERE". While it was app-wide, pane A opening a pass
   * invalidated pane B's in-flight one, so B's artboards 1..n never reached `ready` and every edit
   * in B escalated to a full render, permanently. The VALUES are still globally unique — see
   * {@link nextRenderGeneration} — because the iframe host caches a pass's resolved document by
   * generation identity.
   */
  renderGeneration: number;
}

/**
 * The next render generation, monotonic across every surface.
 *
 * Unique across panes even though the comparison is per-pane: `iframe-host.ts`'s
 * `preparePassRender` caches the resolved+serialized document on `byDoc` keyed by the generation's
 * identity, so two surfaces reusing the number would thrash that cache — and the frame's own
 * `latestGen` drop rule would start discarding the other pane's live renders.
 */
let _nextGen = 0;

/** Take the next globally-unique render generation. */
export function nextRenderGeneration(): number {
  _nextGen += 1;
  return _nextGen;
}

const _surfaces = new Map<string, CanvasSurface>();

/**
 * The surface record for a pane, created on first mention.
 *
 * Created rather than looked up so every reader has an answer before the host is attached — the
 * same contract `store.ts`'s shell refs have, and what keeps `activeCanvasSurface()` non-nullable.
 *
 * @param {string} paneId
 * @returns {CanvasSurface}
 */
export function surfaceForPane(paneId: string): CanvasSurface {
  let surface = _surfaces.get(paneId);
  if (!surface) {
    surface = freshSurface(paneId);
    _surfaces.set(paneId, surface);
  }
  return surface;
}

/** A surface record with nothing in it. One place the per-stage defaults are written down. */
function freshSurface(paneId: string): CanvasSurface {
  return {
    centerObserver: null,
    monacoEditor: null,
    needsCenter: true,
    panX: 0,
    panY: 0,
    panels: [],
    paneId,
    panzoomWrap: null,
    prevCanvasMode: null,
    renderGeneration: 0,
    sourceCollabCleanup: null,
    wrap: null as unknown as HTMLElement,
  };
}

/**
 * Every registered surface, in registration order. The grid's inventory, and the tests'.
 *
 * @returns {CanvasSurface[]}
 */
export function allCanvasSurfaces(): CanvasSurface[] {
  return [..._surfaces.values()];
}

/**
 * The stage `node` sits inside, or null when it is outside every one of them.
 *
 * The N-stage replacement for `canvasWrap.contains(target)`. Two document-level gestures — the
 * browser-zoom block and the wheel forwarded out of a frame — need "which stage is this in", and
 * with one stage they were allowed to spell it as "is it in THE stage".
 *
 * @param {Node | null} node
 * @returns {CanvasSurface | null}
 */
export function stageContaining(node: Node | null): CanvasSurface | null {
  if (!node) {
    return null;
  }
  for (const surface of _surfaces.values()) {
    if (surface.wrap?.contains(node)) {
      return surface;
    }
  }
  return null;
}

/**
 * Forget everything a surface's last pass mounted.
 *
 * Dropping the panel records is not enough: each artboard owns a render `EffectScope` (and the
 * surgical-subtree scopes nested inside it) that goes on reacting to the document until it is
 * stopped. The render path has always stopped them before emptying the array; a surface whose HOST
 * changes hands has to do exactly the same, or every handover leaks one live scope per artboard —
 * scopes that then repaint DOM belonging to a stage this pane no longer has.
 */
export function releaseMountedPanels(surface: CanvasSurface): void {
  for (const panel of surface.panels) {
    panel.renderScope?.stop();
    panel.renderScope = null;
  }
  surface.panels.length = 0;
  surface.prevCanvasMode = null;
}

/**
 * Attach a pane's stage element. Called once per host that exists in the shell.
 *
 * A fresh host carries nothing over: the panels named by the previous one are detached DOM and the
 * mode it last drew describes a structure that is gone, so both are cleared here rather than by
 * each caller remembering to.
 *
 * @param {string} paneId
 * @param {HTMLElement} wrap
 * @returns {CanvasSurface}
 */
export function registerCanvasSurface(paneId: string, wrap: HTMLElement): CanvasSurface {
  const surface = surfaceForPane(paneId);
  surface.wrap = wrap;
  releaseMountedPanels(surface);
  return surface;
}

/* There is no `moveCanvasStage`, and there is no handover.
   §18.3 handed the shell's ONE stage to whichever pane had focus, because there was one stage. The
   grid gives every pane its own, registered by `panels/pane-grid.ts` when the cell is built and
   released when it is removed, so nothing moves and no pane is ever left describing DOM it does
   not own. The rule that survives is {@link releaseMountedPanels}: a surface that loses its host
   has to stop the render scope of every artboard it mounted, or each goes on repainting a stage
   that is not there. */

/**
 * Build a pane's surface record from scratch, replacing anything a previous pane of that id left.
 *
 * The grid calls this as it builds a cell, BEFORE the stage element exists — a pane is complete
 * before it is published (§18.1 rule 1), and that includes the record every renderer resolves
 * through.
 *
 * @param {string} paneId
 * @returns {CanvasSurface}
 */
export function createPaneSurface(paneId: string): CanvasSurface {
  const existing = _surfaces.get(paneId);
  if (existing) {
    disposePaneSurface(paneId);
  }
  const surface = freshSurface(paneId);
  _surfaces.set(paneId, surface);
  return surface;
}

/**
 * How a surface releases the editors and observers its renders created.
 *
 * Injected, because the teardown lives in `canvas/canvas-render.ts` — which imports this module —
 * and a surface record must stay reachable from the dependency-light half of the graph. Same idiom
 * as `setIframePatchEscalation`.
 */
let _teardown: ((surface: CanvasSurface) => void) | null = null;

/** Register the per-surface teardown. Called once, at import time, by `canvas-render.ts`. */
export function setSurfaceTeardown(fn: ((surface: CanvasSurface) => void) | null): void {
  _teardown = fn;
}

/**
 * Release everything a pane's stage owns and forget the record.
 *
 * Ordered: the render-owned surfaces first (through the injected teardown — Monaco, the collab
 * binding, the centering observer), then the artboards' render scopes, then the record. The DOM is
 * the caller's: `pane-grid.ts` removes the cell, and `iframe-host.ts`'s `releaseCanvasHosts` tears
 * the frames down BEFORE the removal, while they are still reachable from the stage.
 *
 * @param {string} paneId
 */
export function disposePaneSurface(paneId: string): void {
  const surface = _surfaces.get(paneId);
  if (!surface) {
    return;
  }
  _teardown?.(surface);
  releaseMountedPanels(surface);
  unregisterCanvasSurface(paneId);
}

/** Forget a pane's surface record without releasing anything. Tests, and the app reset. */
export function unregisterCanvasSurface(paneId: string): void {
  _surfaces.delete(paneId);
}
