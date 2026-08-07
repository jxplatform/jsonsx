/// <reference lib="dom" />
/**
 * Canvas surfaces — one stage per pane.
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
 * A surface is addressed by pane id and nothing else. `#canvas-wrap` is the primary pane's stage
 * and is registered by {@link registerCanvasSurface} from `initShellRefs`; a second pane registers
 * its own host the same way, and every reader below already asks which pane it means.
 */

import { paneById, workspace } from "../workspace/workspace";

import type { CanvasPanel } from "../types";
import type { Tab } from "../tabs/tab";

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
    surface = {
      panels: [],
      paneId,
      prevCanvasMode: null,
      wrap: null as unknown as HTMLElement,
    };
    _surfaces.set(paneId, surface);
  }
  return surface;
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
function releaseMountedPanels(surface: CanvasSurface): void {
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

/**
 * Hand a stage element to a pane, taking it from whichever pane held it.
 *
 * A pane is the unit of render, and the shell has one stage — so "which pane's stage is this" has a
 * MOVING answer: the focused one. `⌘\` splits and focuses the new pane, and the tab it moved has to
 * appear on the only stage there is.
 *
 * Taking is half of giving, and skipping that half is what made this a crash rather than a
 * mis-paint: the losing pane kept `panels` naming artboards about to be torn out (so
 * {@link panelHostingCanvas} answered with a dead pane), a `prevCanvasMode` describing a structure
 * it no longer owned (so its next pass would skip the teardown it needs) and a live render scope
 * per artboard (see {@link releaseMountedPanels}).
 *
 * When a second host lands this is DELETED, not extended — each pane registers its own stage
 * through {@link registerCanvasSurface} and nothing moves.
 *
 * @param {string} paneId
 * @param {HTMLElement} wrap
 * @returns {CanvasSurface}
 */
export function moveCanvasStage(paneId: string, wrap: HTMLElement): CanvasSurface {
  for (const surface of _surfaces.values()) {
    if (surface.paneId !== paneId && surface.wrap === wrap) {
      surface.wrap = null as unknown as HTMLElement;
      releaseMountedPanels(surface);
    }
  }
  return registerCanvasSurface(paneId, wrap);
}

/** The focused pane's stage — what "the canvas" means to a command the person just ran. */
export function activeCanvasSurface(): CanvasSurface {
  return surfaceForPane(workspace.activePaneId);
}

/**
 * The tab a pane is showing, or null when it shows none.
 *
 * `activeTab` answers this for the FOCUSED pane only; a render, a patch classification and an
 * escalation each need it for a named pane instead.
 *
 * @param {string} paneId
 * @returns {Tab | null}
 */
export function tabOfPane(paneId: string): Tab | null {
  const activeTabId = paneById(paneId)?.activeTabId;
  return activeTabId ? (workspace.tabs.get(activeTabId) ?? null) : null;
}

/**
 * The stage showing `tab`, or null when no pane has it on screen.
 *
 * This is the per-pane replacement for `isTabActive(tab)` in the patcher's gate, and it is strictly
 * more truthful: a tab is patchable because some pane is DISPLAYING it, not because it happens to
 * be the one the keyboard is in.
 *
 * @param {Tab | null} tab
 * @returns {CanvasSurface | null}
 */
export function surfaceShowingTab(tab: Tab | null): CanvasSurface | null {
  if (!tab) {
    return null;
  }
  const pane = workspace.panes.find((candidate) => candidate.activeTabId === tab.id);
  return pane ? surfaceForPane(pane.id) : null;
}

/**
 * The stage and artboard that mounted `canvasEl`, or null when no pane did.
 *
 * The iframe host knows only its own canvas element, and both answers it needs are here: which
 * artboard was clicked (so the breakpoint context follows the click rather than panel 0), and which
 * PANE a `patchError` must escalate — escalating "the canvas" would re-render a pane that never saw
 * the patch.
 *
 * @param {HTMLElement} canvasEl
 * @returns {{ surface: CanvasSurface; panel: CanvasPanel } | null}
 */
export function panelHostingCanvas(
  canvasEl: HTMLElement,
): { surface: CanvasSurface; panel: CanvasPanel } | null {
  for (const surface of _surfaces.values()) {
    const panel = surface.panels.find((candidate) => candidate.canvas === canvasEl);
    if (panel) {
      return { panel, surface };
    }
  }
  return null;
}

/**
 * The tab whose document an already-mounted artboard is drawing, or null when no pane mounted it.
 *
 * The artboard is the addressable thing a click lands on — its header, its canvas — and the pane
 * that mounted it is the only truthful route from there to a document. Reading `activeTab` instead
 * answers with the FOCUSED pane's tab, which is a different document the moment the click is in a
 * pane the keyboard is not in.
 *
 * @param {CanvasPanel} panel
 * @returns {Tab | null}
 */
export function tabOfMountedPanel(panel: CanvasPanel): Tab | null {
  const canvasEl = panel.canvas as HTMLElement | null;
  const mounted = canvasEl ? panelHostingCanvas(canvasEl) : null;
  return mounted ? tabOfPane(mounted.surface.paneId) : null;
}

/**
 * The effective canvas mode of a tab: the per-tab preview toggle composed onto its base mode.
 *
 * The composition is the same one every downstream gate (document resolution, iframe flags,
 * interaction surfaces) reads, and it lives here — beside the panes — because the answer is a
 * property of a pane's tab, never of the application. Consumers needing the BASE mode read
 * `tab.session.ui.canvasMode` directly.
 *
 * @param {Tab | null} tab
 * @returns {string}
 */
export function canvasModeOfTab(tab: Tab | null): string {
  const ui = tab?.session.ui;
  const base = ui?.canvasMode ?? "design";
  return ui?.preview && (base === "edit" || base === "design") ? "preview" : base;
}

/**
 * The effective canvas mode a pane is in.
 *
 * @param {string} paneId
 * @returns {string}
 */
export function canvasModeOfPane(paneId: string): string {
  return canvasModeOfTab(tabOfPane(paneId));
}
