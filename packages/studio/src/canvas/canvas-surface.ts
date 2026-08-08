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
import type { PaneDerivation } from "../workspace/workspace";
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
 * The tab a pane is DISPLAYING, or null when it shows none.
 *
 * `activeTab` answers this for the FOCUSED pane only; a render, a patch classification and an
 * escalation each need it for a named pane instead.
 *
 * **This one hop is the leverage of the whole derivation.** A LENS pane owns no tab — its
 * `tabOrder` is `[]` — and displays the document its source pane owns, so the answer comes from
 * `sourcePaneId`. Every reader that was already written pane-scoped therefore starts working on a
 * lens pane for free: `renderCanvasImpl`, all three `installPaneRenderEffects` effects, the pane
 * context bar, the jump bar, `tabOfContainer`, `tabOfMountedPanel` and `mountSourceEditor`'s
 * post-await guard. That is also why the follow costs nothing: switching tabs in the source pane
 * repaints the lens because it is the same reactive read.
 *
 * A COMPANION pane owns its tabs normally and takes no hop — the derivation only decides which of
 * its own tabs is on screen.
 *
 * The distinction this draws is not a new one in the render path: `mountIframeCanvas(gen, doc,
 * canvasEl, widthPx, tabId, viewTab)` has separated "where do this frame's mutations go" from
 * "whose document path, layout toggle and canvas mode resolve it" since the git-diff override. A
 * lens lifts that pair to the pane.
 *
 * @param {string} paneId
 * @returns {Tab | null}
 */
export function tabOfPane(paneId: string): Tab | null {
  const pane = paneById(paneId);
  const derived = pane?.derived;
  const activeTabId =
    derived?.kind === "lens" ? paneById(derived.sourcePaneId)?.activeTabId : pane?.activeTabId;
  return activeTabId ? (workspace.tabs.get(activeTabId) ?? null) : null;
}

/**
 * The derivation a pane is drawing under, or null for an ordinary pane.
 *
 * Here rather than in `workspace/pane-derive.ts` (which owns the WRITERS) because every reader of
 * it is a pane-scoped renderer already resolving through this module, and `pane-derive.ts` imports
 * {@link tabOfPane} from here — the other direction would be a cycle.
 *
 * @param {string} paneId
 * @returns {PaneDerivation | null}
 */
export function derivationOfPane(paneId: string): PaneDerivation | null {
  return paneById(paneId)?.derived ?? null;
}

/**
 * Every stage displaying `tab` — its owning pane's, plus any derived pane projecting that pane.
 *
 * This is the per-pane replacement for `isTabActive(tab)` in the patcher's gate, and it is strictly
 * more truthful: a tab is patchable because some pane is DISPLAYING it, not because it happens to
 * be the one the keyboard is in.
 *
 * **Plural, and not kept as a singular wrapper.** `surfaceShowingTab` returned the FIRST pane whose
 * `activeTabId` matched, which was a complete answer only while a tab could be on screen in one
 * place. A lens pane displays the tab its source pane owns (`tabOfPane` takes the hop), so a
 * function answering "the one pane" when there may be two is precisely the defect this workstream
 * is about: the patcher posted one pane's `renderGeneration` to both hosts, and the host whose own
 * generation was higher dropped the patch without a sound.
 *
 * Resolved through {@link tabOfPane} rather than through `pane.activeTabId`, so the lens hop is
 * written once.
 *
 * @param {Tab | null} tab
 * @returns {CanvasSurface[]}
 */
export function surfacesShowingTab(tab: Tab | null): CanvasSurface[] {
  if (!tab) {
    return [];
  }
  const out: CanvasSurface[] = [];
  for (const pane of workspace.panes) {
    if (tabOfPane(pane.id)?.id === tab.id) {
      out.push(surfaceForPane(pane.id));
    }
  }
  return out;
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
 * The effective canvas mode a pane is drawing in.
 *
 * A LENS draws the source pane's document in a mode of its OWN — that is most of what a lens is —
 * and that mode is never written onto the tab, because the tab belongs to the pane beside it and
 * writing there would flip the document the author is editing. The per-tab preview toggle still
 * composes onto it, so a preview lens of an edit-mode page is still a preview.
 *
 * @param {string} paneId
 * @returns {string}
 */
export function canvasModeOfPane(paneId: string): string {
  const derived = derivationOfPane(paneId);
  if (derived?.kind === "lens") {
    const base = derived.mode;
    const ui = tabOfPane(paneId)?.session.ui;
    return ui?.preview && (base === "edit" || base === "design") ? "preview" : base;
  }
  return canvasModeOfTab(tabOfPane(paneId));
}

/**
 * The breakpoint a pane is drawing at — `null` for base.
 *
 * `session.ui.activeMedia` is per-TAB, so a breakpoint lens reading it would be showing the same
 * artboard as the pane it is a lens of, which is the one thing preset 5 exists not to do. The
 * derivation's own `media` wins for a lens; every other pane answers from its tab exactly as
 * before.
 *
 * @param {string} paneId
 * @returns {string | null}
 */
export function activeMediaOfPane(paneId: string): string | null {
  const derived = derivationOfPane(paneId);
  if (derived?.kind === "lens" && derived.preset === "breakpoint") {
    return derived.media;
  }
  return tabOfPane(paneId)?.session.ui.activeMedia ?? null;
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
