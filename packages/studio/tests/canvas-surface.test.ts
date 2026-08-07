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
  canvasModeOfPane,
  canvasModeOfTab,
  panelHostingCanvas,
  registerCanvasSurface,
  surfaceForPane,
  surfaceShowingTab,
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

  test("surfaceShowingTab finds the pane displaying a tab, even when it is not the focused one", () => {
    const left = openTab({ document: { children: [], tagName: "div" }, id: "surface-left" }) as Tab;
    const right = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "/p/right.js",
      id: "surface-right",
    }) as Tab;
    // `source` is a SECONDARY_PANE_KINDS kind, so the split is allowed to take this tab.
    right.session.ui.canvasMode = "source";
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);

    // The FOCUSED pane is the second one, and the first pane's tab is still found.
    expect(surfaceShowingTab(left)?.paneId).toBe(PRIMARY_PANE);
    expect(surfaceShowingTab(right)?.paneId).toBe(SECONDARY_PANE);
    workspace.activePaneId = PRIMARY_PANE;
  });

  test("surfaceShowingTab is null for no tab and for a tab no pane has on screen", () => {
    const shown = openTab({ document: { children: [], tagName: "div" }, id: "surface-shown" });
    const hidden = openTab({
      document: { children: [], tagName: "div" },
      id: "surface-hidden",
    }) as Tab;
    // Opening the second tab made it active; re-activating the first leaves `hidden` in the strip
    // But off screen.
    workspace.panes[0]!.activeTabId = (shown as Tab).id;
    expect(surfaceShowingTab(hidden)).toBeNull();
    expect(surfaceShowingTab(null)).toBeNull();
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

  test("a pane showing nothing reads as design, not as the other pane's mode", () => {
    const tab = openTab({ document: { children: [], tagName: "div" }, id: "surface-mode2" }) as Tab;
    tab.session.ui.canvasMode = "source";
    expect(canvasModeOfPane(PRIMARY_PANE)).toBe("source");
    expect(canvasModeOfPane(SECONDARY_PANE)).toBe("design");
    expect(canvasModeOfTab(null)).toBe("design");
  });
});
