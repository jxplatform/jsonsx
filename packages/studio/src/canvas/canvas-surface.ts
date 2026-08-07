/// <reference lib="dom" />
/**
 * Canvas surfaces — one stage per pane, asked about the pane it belongs to.
 *
 * A pane is the unit of split, focus and zoom (§4.1), so it is also the unit of RENDER. The panels
 * a pass mounted, the host element they mounted into, the mode that pass was drawn in and the full
 * render a failed patch escalates to are all facts about ONE pane; they were app-level singletons
 * only because the shell had a single stage.
 *
 * The RECORDS live in `./surface-registry`, which knows nothing about tabs (see the note there on
 * the cycle that forced the split). Everything here composes a surface with the workspace: which
 * tab a pane is showing, which stage is showing a tab, which pane mounted an artboard.
 */

import { PRIMARY_PANE, paneById, workspace } from "../workspace/workspace";
import { allCanvasSurfaces, stageContaining, surfaceForPane } from "./surface-registry";
import type { CanvasSurface } from "./surface-registry";
import type { CanvasPanel } from "../types";
import type { Tab } from "../tabs/tab";

export {
  STAGE_CLASS,
  allCanvasSurfaces,
  createPaneSurface,
  disposePaneSurface,
  nextRenderGeneration,
  registerCanvasSurface,
  releaseMountedPanels,
  setSurfaceTeardown,
  stageContaining,
  surfaceForPane,
  unregisterCanvasSurface,
} from "./surface-registry";
export type { CanvasSurface } from "./surface-registry";

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
  for (const surface of allCanvasSurfaces()) {
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

/**
 * Which pane an element is being drawn into, DERIVED from the element itself.
 *
 * The route for stage CONTENT that is handed a host and nothing else. The settings-section registry
 * is the case that forced it — a contribution's `render(host)` takes an element, and widening that
 * contract for every extension to thread a pane id through is not on — but the shape is general:
 * the container is inside a stage, and the stage knows whose it is.
 *
 * Falls back to the primary for a detached container (the tests, and anything drawn outside the
 * pane grid entirely), which is the same answer `resolveRegion("pane")` gives.
 *
 * @param {HTMLElement} container
 * @returns {string}
 */
export function paneOfContainer(container: HTMLElement): string {
  return stageContaining(container)?.paneId ?? PRIMARY_PANE;
}

/** The tab whose document is being edited in the stage `container` sits inside, or null. */
export function tabOfContainer(container: HTMLElement): Tab | null {
  return tabOfPane(paneOfContainer(container));
}
