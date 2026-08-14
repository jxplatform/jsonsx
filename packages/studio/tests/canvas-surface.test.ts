/**
 * Canvas surfaces — one stage per pane.
 *
 * The point of this module is that nothing about a stage is answerable "for the app": the panels,
 * the mode and the render a failed patch escalates to each belong to ONE pane. So every test here
 * asks a question of a named pane and checks that the OTHER pane's answer is unaffected — that is
 * the property, and it is the one that could not be tested at all while these were globals.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activeCanvasSurface,
  activeMediaOfPane,
  canvasModeOfPane,
  canvasModeOfTab,
  panelHostingCanvas,
  registerCanvasSurface,
  surfaceForPane,
  surfacesShowingTab,
  tabOfPane,
} from "../src/canvas/canvas-surface";
import {
  closeAllTabs,
  openTab,
  PRIMARY_PANE,
  SECONDARY_PANE,
  splitRight,
  workspace,
} from "../src/workspace/workspace";

import type { CanvasPanel } from "../src/types";
import type { Tab } from "../src/tabs/tab";

/** A stand-in artboard: only `canvas` and `ready` are read by anything under test. */
function panelOn(canvas: HTMLElement, ready = true): CanvasPanel {
  return { canvas, mediaName: "base", ready } as unknown as CanvasPanel;
}

function wrap(id: string): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
  return el;
}

let primaryWrap: HTMLElement;

beforeEach(() => {
  closeAllTabs();
  primaryWrap = wrap("canvas-wrap");
  registerCanvasSurface(PRIMARY_PANE, primaryWrap);
  registerCanvasSurface(SECONDARY_PANE, wrap("canvas-wrap-2"));
});

afterEach(() => {
  closeAllTabs();
  registerCanvasSurface(PRIMARY_PANE, primaryWrap);
  registerCanvasSurface(SECONDARY_PANE, wrap("canvas-wrap-2"));
  document.body.innerHTML = "";
});

describe("the surface registry", () => {
  test("a pane's surface exists before its host does, and is the same record afterwards", () => {
    const before = surfaceForPane("pane-not-in-the-shell");
    expect(before.paneId).toBe("pane-not-in-the-shell");
    expect(before.panels).toEqual([]);
    expect(before.prevCanvasMode).toBeNull();
    expect(surfaceForPane("pane-not-in-the-shell")).toBe(before);
  });

  test("attaching a fresh host clears what the previous one mounted", () => {
    const surface = surfaceForPane(PRIMARY_PANE);
    surface.panels.push(panelOn(document.createElement("div")));
    surface.prevCanvasMode = "design";

    const replacement = wrap("canvas-wrap-replacement");
    const same = registerCanvasSurface(PRIMARY_PANE, replacement);

    // Same record — every module holding a reference keeps addressing this pane…
    expect(same).toBe(surface);
    // …and the panels array identity survives too, but its CONTENTS are the new host's (none).
    expect(same.wrap).toBe(replacement);
    expect(same.panels).toHaveLength(0);
    expect(same.prevCanvasMode).toBeNull();
  });

  test("activeCanvasSurface follows the focused pane", () => {
    expect(activeCanvasSurface().paneId).toBe(PRIMARY_PANE);
    workspace.activePaneId = SECONDARY_PANE;
    expect(activeCanvasSurface().paneId).toBe(SECONDARY_PANE);
    workspace.activePaneId = PRIMARY_PANE;
  });
});

/* There is no `moveCanvasStage` test block, because there is no handover.
   It protected the TAKING half of a one-stage shell: a pane that kept a wrap it no longer owned
   was a pane whose next render repainted the other pane's document. With a cell per pane nothing
   is taken — `panels/pane-grid.ts` registers a stage when it builds a cell and disposes it when it
   removes one — and what survives is {@link releaseMountedPanels}, exercised through
   `disposePaneSurface` below. */

describe("which pane is showing what", () => {
  test("tabOfPane answers per pane, and null for a pane showing nothing", () => {
    const tab = openTab({ document: { children: [], tagName: "div" }, id: "surface-a" }) as Tab;
    expect(tabOfPane(PRIMARY_PANE)?.id).toBe(tab.id);
    expect(tabOfPane(SECONDARY_PANE)).toBeNull();
    expect(tabOfPane("no-such-pane")).toBeNull();
  });

  test("surfacesShowingTab finds the pane displaying a tab, even when it is not the focused one", () => {
    const left = openTab({ document: { children: [], tagName: "div" }, id: "surface-left" }) as Tab;
    const right = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "/p/right.js",
      id: "surface-right",
    }) as Tab;
    right.session.ui.canvasMode = "source";
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);

    // The FOCUSED pane is the second one, and the first pane's tab is still found.
    expect(surfacesShowingTab(left).map((s) => s.paneId)).toEqual([PRIMARY_PANE]);
    expect(surfacesShowingTab(right).map((s) => s.paneId)).toEqual([SECONDARY_PANE]);
    workspace.activePaneId = PRIMARY_PANE;
  });

  test("surfacesShowingTab names BOTH panes when one document is on two stages", () => {
    /* The answer `surfaceShowingTab` could not give. It returned the FIRST matching pane, so the
       second stage drawing the same document was invisible to the patcher: it was posted a patch
       carrying the other pane's generation and dropped it in silence. */
    const tab = openTab({ document: { children: [], tagName: "div" }, id: "surface-both" }) as Tab;
    const other = openTab({ document: { children: [], tagName: "div" }, id: "surface-other" });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    workspace.panes[0]!.activeTabId = tab.id;
    workspace.panes[1]!.activeTabId = tab.id;
    expect(surfacesShowingTab(tab).map((s) => s.paneId)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
    void other;
    workspace.activePaneId = PRIMARY_PANE;
  });

  test("surfacesShowingTab is empty for no tab and for a tab no pane has on screen", () => {
    const shown = openTab({ document: { children: [], tagName: "div" }, id: "surface-shown" });
    const hidden = openTab({
      document: { children: [], tagName: "div" },
      id: "surface-hidden",
    }) as Tab;
    // Opening the second tab made it active; re-activating the first leaves `hidden` in the strip
    // But off screen.
    workspace.panes[0]!.activeTabId = (shown as Tab).id;
    expect(surfacesShowingTab(hidden)).toEqual([]);
    expect(surfacesShowingTab(null)).toEqual([]);
  });
});

describe("panelHostingCanvas", () => {
  test("names the artboard AND the pane that mounted it", () => {
    const canvasEl = document.createElement("div");
    const panel = panelOn(canvasEl);
    surfaceForPane(SECONDARY_PANE).panels.push(panel);

    const found = panelHostingCanvas(canvasEl);
    expect(found?.panel).toBe(panel);
    expect(found?.surface.paneId).toBe(SECONDARY_PANE);
  });

  test("is null for an element no pane mounted", () => {
    expect(panelHostingCanvas(document.createElement("div"))).toBeNull();
  });
});

describe("the canvas mode of a pane", () => {
  test("composes the preview toggle onto the base mode, per tab", () => {
    const tab = openTab({ document: { children: [], tagName: "div" }, id: "surface-mode" }) as Tab;
    tab.session.ui.canvasMode = "design";
    expect(canvasModeOfTab(tab)).toBe("design");

    tab.session.ui.preview = true;
    expect(canvasModeOfTab(tab)).toBe("preview");

    // Preview composes onto edit/design only — a Code view stays a Code view.
    tab.session.ui.canvasMode = "source";
    expect(canvasModeOfTab(tab)).toBe("source");

    tab.session.ui.canvasMode = "edit";
    expect(canvasModeOfTab(tab)).toBe("preview");
  });

  /* THE PREVIEW TOGGLE COMPOSES ONTO A LENS'S OWN MODE, and it has to: `session.ui.preview` is per
     TAB and a lens shares the source pane's tab, so a lens that ignored it would draw the design
     board beside a page the author had just put into Preview — two panes on one document
     disagreeing about whether it is a preview. Only the two artboard modes compose; a Code or Diff
     lens has no preview to be, which is why the pair is named rather than defaulted. */
  test("a lens composes the shared tab's preview toggle onto the mode it draws in", () => {
    const tab = openTab({ document: { children: [], tagName: "div" }, id: "surface-mode-lens" });
    workspace.panes.push({ activeTabId: null, derived: null, id: SECONDARY_PANE, tabOrder: [] });
    const derived = {
      diff: null,
      kind: "lens",
      media: null,
      mode: "design",
      preset: "breakpoint",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
    };
    workspace.panes[1]!.derived = derived as never;
    expect(canvasModeOfPane(SECONDARY_PANE)).toBe("design");

    tab.session.ui.preview = true;
    expect(canvasModeOfPane(SECONDARY_PANE)).toBe("preview");

    // A Code lens has no preview to be — the mode it names wins outright.
    Object.assign(derived, { mode: "source", preset: "code" });
    expect(canvasModeOfPane(SECONDARY_PANE)).toBe("source");
  });

  test("a pane showing nothing reads as design, not as the other pane's mode", () => {
    const tab = openTab({ document: { children: [], tagName: "div" }, id: "surface-mode2" }) as Tab;
    tab.session.ui.canvasMode = "source";
    expect(canvasModeOfPane(PRIMARY_PANE)).toBe("source");
    expect(canvasModeOfPane(SECONDARY_PANE)).toBe("design");
    expect(canvasModeOfTab(null)).toBe("design");
  });
});

/* `activeMediaOfPane` is the pane-scoped answer preset 5 is BUILT ON — the artboard the stage
   draws, the header marked active, the panel a click resolves to and the Context axis all read it
   — and nothing asserted the lens branch at all. Deleting it left 8123 tests green while every
   breakpoint lens in the app silently drew the source pane's breakpoint, which is the one thing
   "the same page at another size" exists not to do. */
describe("the breakpoint a pane is drawing at", () => {
  /** A breakpoint lens on the secondary, over the primary's tab. */
  function breakpointLens(media: string | null): Tab {
    const tab = openTab({
      document: { children: [], tagName: "div" },
      id: "surface-media",
    }) as Tab;
    // The lens shares this tab, so the tab's own breakpoint is the WRONG answer for it by design.
    tab.session.ui.activeMedia = "wide";
    workspace.panes.push({ activeTabId: null, derived: null, id: SECONDARY_PANE, tabOrder: [] });
    workspace.panes[1]!.derived = {
      diff: null,
      kind: "lens",
      media,
      mode: "design",
      preset: "breakpoint",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
    };
    return tab;
  }

  test("a breakpoint lens answers with ITS media, never the tab it shares", () => {
    breakpointLens("tablet");
    expect(activeMediaOfPane(PRIMARY_PANE)).toBe("wide");
    expect(activeMediaOfPane(SECONDARY_PANE)).toBe("tablet");
  });

  test("a BASE breakpoint lens answers null — not the tab's, which is a real breakpoint", () => {
    /* The base row is the case a `?? tab.session.ui.activeMedia` fallback gets wrong in the most
       confusing direction: `null` is the lens's ANSWER, not a missing one. */
    breakpointLens(null);
    expect(activeMediaOfPane(SECONDARY_PANE)).toBeNull();
  });

  test("every other pane answers from its own tab, lens or not", () => {
    const tab = breakpointLens("tablet");
    // A CODE lens is not a breakpoint lens: it draws the shared tab's breakpoint, because the
    // Only view fact it overrides is the mode.
    const derived = workspace.panes[1]!.derived as { preset: string; media: string | null };
    derived.preset = "code";
    expect(activeMediaOfPane(SECONDARY_PANE)).toBe("wide");
    // …and an ordinary pane with nothing open answers null rather than borrowing.
    workspace.panes[1]!.derived = null;
    expect(activeMediaOfPane(SECONDARY_PANE)).toBeNull();
    tab.session.ui.activeMedia = null;
    expect(activeMediaOfPane(PRIMARY_PANE)).toBeNull();
  });
});
