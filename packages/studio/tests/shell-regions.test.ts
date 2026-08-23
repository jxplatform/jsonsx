/**
 * The region ids the shell actually stamps — the derivation, exercised against real renders.
 *
 * `regions.test.ts` covers the grammar and the resolver in isolation. This file covers the claim
 * that matters: that the ids are DERIVED. Every assertion below reaches for a region without any
 * surface having authored its id, so a panel rename, a tab re-split or an overlay moving layer
 * propagates here instead of leaving a stale address behind.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mountShellTree } from "../src/shell/tree";
import { html } from "lit-html";
import * as leftPanelModule from "../src/panels/left-panel";
import * as rightPanelModule from "../src/panels/right-panel";
import { mountStatusbar, renderStatusbar, unmountStatusbar } from "../src/panels/statusbar";
import { initShellRefs, leftPanel, rightPanel } from "../src/store";
import { closeAllTabs } from "../src/workspace/workspace";
import { view } from "../src/view";
import { shell } from "../src/shell";
import { listRegions, resolveRegion } from "../src/ui/regions";
/* Imported for its side effect: the grid registers itself as a shell surface at import time, the
   same bargain `ui/panel-resize.ts` makes, so `mountShell()` below draws the pane cells. `studio.ts`
   gets this for free by importing `cellForPane`; a test that mounts the shell without the
   bootstrap has to say so. */
import "../src/panels/pane-grid";

/* The real frame. This used to be nine hand-listed divs plus `stampShellRegions()` to give them the
   region ids they could not carry themselves — and it was missing the bottom dock and the toast
   host, like every other hand-written copy. `src/shell/tree.ts` is the one definition and stamps its
   own ids, which is what most of this file is about. */

beforeEach(() => {
  mountShellTree();
  initShellRefs();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  view.dndCleanups = [];
  view._layersCollapsed = new Set();
  resetStudioState();
});

afterEach(() => {
  leftPanelModule.unmount();
  rightPanelModule.unmount();
  unmountStatusbar();
  closeAllTabs();
  document.body.innerHTML = "";
});

// ─── The shell hosts ──────────────────────────────────────────────────────────

describe("the frame's own regions, through mountShell", () => {
  test("the five fixed surfaces resolve from the table after boot", async () => {
    const { mountShell, unmountShell } = await import("../src/shell");
    mountShell();
    try {
      expect(resolveRegion("commandbar")?.id).toBe("toolbar");
      expect(resolveRegion("rail")?.id).toBe("activity-bar");
      expect(resolveRegion("navigator")?.id).toBe("left-panel");
      expect(resolveRegion("inspector")?.id).toBe("right-panel");
      expect(resolveRegion("statusbar")?.id).toBe("statusbar");
    } finally {
      unmountShell();
    }
  });

  test("the pane's ids come from its CELL, not from a `<div id>` in the table", async () => {
    const { mountShell, unmountShell } = await import("../src/shell");
    mountShell();
    try {
      /* No `.id` to assert against, and that is the change: `pane.primary` named `#canvas-wrap`
         and `pane.primary/tabs` named `#tab-strip`, two application-grid siblings that could only
         ever be one pane's. Both are derived from the pane id now, so the assertion is about the
         SHAPE the grid built. */
      const stage = resolveRegion("pane.primary");
      expect(stage?.classList.contains("pane-stage")).toBe(true);
      expect(resolveRegion("pane.primary/tabs")?.classList.contains("pane-strip")).toBe(true);
      // `pane` is the primary pane, so an id minted before the second pane still means what it did.
      expect(resolveRegion("pane")).toBe(stage);
      // And the cell is inside the grid host, not a sibling of it.
      expect(document.querySelector("#pane-grid")!.contains(stage)).toBe(true);
    } finally {
      unmountShell();
    }
  });
});

// ─── navigator/panel:<id>, stamped once by the panel host ─────────────────────

function leftCtx(overrides: Record<string, unknown> = {}) {
  return {
    defaultDef: (tag: string) => ({ tagName: tag }),
    defBadgeLabel: () => "badge",
    defCategory: () => "cat",
    getCanvasMode: mock(() => "design"),
    navigateToComponent: mock(() => {}),
    refreshData: mock(() => {}),
    registerComponentsDnD: mock(() => {}),
    registerElementsDnD: mock(() => {}),
    registerFileTreeDnD: mock(() => {}),
    registerLayersDnD: mock(() => {}),
    renderCanvas: mock(() => {}),
    renderFilesTemplate: mock(() => html`<div class="file-tree"></div>`),
    renderGitPanel: mock(
      () => html`<div class="git-commit-area" data-jx-region="navigator/panel:git/commit"></div>`,
    ),
    renderHeadTemplate: mock(() => html`<div id="head-rendered"></div>`),
    renderImportsTemplate: mock(() => html`<div id="imports-rendered"></div>`),
    renderSignalsTemplate: mock(() => html`<div id="signals-rendered"></div>`),
    setCanvasMode: mock(() => {}),
    setGitDiffState: mock(() => {}),
    setupTreeKeyboard: mock(() => {}),
    webdata: { elements: { Text: [{ tag: "p" }] } },
    ...overrides,
  };
}

describe("navigator/panel:<id>", () => {
  /** Every panel the left panel routes to — the ids that come free from one stamp. */
  const PANELS = ["files", "git", "insert", "layers", "packages", "data", "page"];

  for (const panel of PANELS) {
    test(`"${panel}" is addressable without anyone authoring its id`, async () => {
      resetWorkspaceWithTab();
      shell.leftTab = panel;
      leftPanelModule.mount(leftCtx() as never);
      await flush(3);

      const region = resolveRegion(`navigator/panel:${panel}`);
      expect(region).not.toBeNull();
      expect(region!.classList.contains("panel-body")).toBe(true);
      expect(leftPanel.contains(region)).toBe(true);
    });
  }

  test("a document-level panel with no document still names its region", async () => {
    closeAllTabs();
    shell.leftTab = "layers";
    leftPanelModule.mount(leftCtx() as never);
    await flush(3);
    expect(resolveRegion("navigator/panel:layers")).not.toBeNull();
  });

  test("exactly one panel region is on screen at a time", async () => {
    resetWorkspaceWithTab();
    shell.leftTab = "data";
    leftPanelModule.mount(leftCtx() as never);
    await flush(3);
    const panelRegions = listRegions().filter((id) => id.startsWith("navigator/panel:"));
    expect(panelRegions).toEqual(["navigator/panel:data"]);
  });

  test("a leaf inside a panel is hand-stamped and nests under the derived one", async () => {
    resetWorkspaceWithTab();
    shell.leftTab = "git";
    leftPanelModule.mount(leftCtx() as never);
    await flush(3);
    const commit = resolveRegion("navigator/panel:git/commit");
    expect(commit).not.toBeNull();
    expect(resolveRegion("navigator/panel:git")!.contains(commit)).toBe(true);
  });
});

// ─── inspector/tab:<value>, stamped from the tab records ──────────────────────

describe("inspector/tab:<value>", () => {
  function mountInspector() {
    rightPanelModule.mount({
      getCanvasMode: mock(() => "design"),
      mountAssistant: mock(() => {}),
      navigateToComponent: mock(() => {}),
      renderCanvas: mock(() => {}),
    } as never);
  }

  test("all four tab bodies are addressable, and only the active one is shown", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.rightTab = "style";
    mountInspector();
    await flush(3);

    for (const key of ["properties", "style", "events", "assistant"]) {
      const body = resolveRegion(`inspector/tab:${key}`);
      expect(body).not.toBeNull();
      expect(rightPanel.contains(body)).toBe(true);
    }
    expect(resolveRegion("inspector/tab:style")!.style.display).toBe("");
    expect(resolveRegion("inspector/tab:properties")!.style.display).toBe("none");
  });

  test("an unknown stored tab falls back to the first record, not to a dead region", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.rightTab = "content";
    mountInspector();
    await flush(3);
    expect(resolveRegion("inspector/tab:properties")!.style.display).toBe("");
    expect(resolveRegion("inspector/tab:content")).toBeNull();
  });
});

// ─── statusbar/selection ──────────────────────────────────────────────────────

describe("statusbar/selection", () => {
  test("the selection field is its own region, and absent when nothing is selected", () => {
    const tab = resetWorkspaceWithTab();
    mountStatusbar();
    renderStatusbar();
    expect(resolveRegion("statusbar/selection")).toBeNull();

    // A BATCH: since region ⑥ took the ancestor trail, a single selection leaves this field empty
    // (`statusbar.test.ts` states why), and the COUNT is what still renders it.
    tab.session.selection = [
      ["children", 0],
      ["children", 1],
    ];
    renderStatusbar();
    const field = resolveRegion("statusbar/selection");
    expect(field).not.toBeNull();
    expect(field!.textContent).toContain("2 selected");
    expect(resolveRegion("statusbar")!.contains(field)).toBe(true);
  });

  test("the three fields are separate regions, and PROJECT is not inside SELECTION", () => {
    resetWorkspaceWithTab();
    mountStatusbar();
    renderStatusbar();
    // Transient messages left the bar entirely for the toast host, so the only thing that can
    // Appear beside the selection is another FIELD — and each is addressable on its own. With no
    // Registry composed, every COMMAND item is absent and only the readouts survive, which is the
    // Honest skeleton the bar paints before the bootstrap runs.
    const document_ = resolveRegion("statusbar/document");
    expect(document_).not.toBeNull();
    expect(document_!.textContent).toContain("Saved");
    expect(resolveRegion("statusbar")!.contains(document_)).toBe(true);
    expect(resolveRegion("statusbar/selection")).toBeNull();
  });
});

// ─── data-jx-path on Outline rows ─────────────────────────────────────────────

describe("Outline rows carry node identity", () => {
  test("every row names its JxPath, and a text row names one too", async () => {
    resetWorkspaceWithTab({
      children: [{ children: ["Hello"], tagName: "p" }],
      tagName: "div",
    });
    shell.leftTab = "layers";
    leftPanelModule.mount(leftCtx() as never);
    await flush(3);

    const paths = [...leftPanel.querySelectorAll<HTMLElement>("[data-jx-path]")].map((el) =>
      JSON.parse(el.dataset.jxPath!),
    );
    expect(paths).toContainEqual([]);
    expect(paths).toContainEqual(["children", 0]);
    // The text node inside the paragraph — previously the one row with no identity at all.
    expect(paths).toContainEqual(["children", 0, "children", 0]);
  });

  test("outlineRowPath reads a path back off a descendant of a row", async () => {
    const { outlineRowPath } = await import("../src/panels/layers-panel");
    resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "Hi" }],
      tagName: "div",
    });
    shell.leftTab = "layers";
    leftPanelModule.mount(leftCtx() as never);
    await flush(3);

    // Matched by reading the attribute rather than by selector: happy-dom's parser cannot handle
    // The escaped quotes a JSON path needs, and the point is the attribute, not the selector.
    const row = [...leftPanel.querySelectorAll<HTMLElement>("[data-jx-path]")].find(
      (el) => el.dataset.jxPath === JSON.stringify(["children", 0]),
    );
    expect(outlineRowPath(row!.querySelector(".layer-label"))).toEqual(["children", 0]);
    expect(outlineRowPath(null)).toBeNull();
    expect(outlineRowPath(document.body)).toBeNull();
  });

  test("a corrupt attribute reads as no path rather than throwing", async () => {
    const { outlineRowPath } = await import("../src/panels/layers-panel");
    const el = document.createElement("div");
    el.dataset.jxPath = "{not json";
    document.body.append(el);
    expect(outlineRowPath(el)).toBeNull();
    el.dataset.jxPath = '"children"';
    expect(outlineRowPath(el)).toBeNull();
  });
});

// ─── overlay.<instance>[:<id>] ────────────────────────────────────────────────

describe("overlay slots stamp themselves", () => {
  test("a named slot's key IS its region, and two are distinguishable", async () => {
    const { clearLayerSlot, getLayerSlot, initLayers } = await import("../src/ui/layers");
    initLayers();
    const zoom = getLayerSlot("popover", "zoom-indicator");
    const bar = getLayerSlot("popover", "block-actions");

    expect(resolveRegion("overlay.menu:zoom-indicator")).toBe(zoom);
    expect(resolveRegion("overlay.menu:block-actions")).toBe(bar);
    expect(zoom).not.toBe(bar);

    clearLayerSlot("popover", "zoom-indicator");
    expect(resolveRegion("overlay.menu:zoom-indicator")).toBeNull();
    clearLayerSlot("popover", "block-actions");
  });

  test("a modal is `overlay.dialog`, and a named one is addressable by name", async () => {
    const { initLayers, openModal } = await import("../src/ui/layers");
    initLayers();
    const anon = openModal(html`<p>body</p>`, { label: "Anonymous" });
    expect(resolveRegion("overlay.dialog")).toBe(anon.host);
    anon.close();

    const named = openModal(html`<p>body</p>`, { label: "Settings", region: "settings" });
    expect(resolveRegion("overlay.dialog:settings")).toBe(named.host);
    named.close();
    expect(resolveRegion("overlay.dialog:settings")).toBeNull();
  });

  test("a popover is `overlay.menu`, and the topmost one wins", async () => {
    const { initLayers, renderPopover } = await import("../src/ui/layers");
    initLayers();
    const first = renderPopover(html`<p>one</p>`, { dismissOnOutsideClick: false });
    const second = renderPopover(html`<p>two</p>`, { dismissOnOutsideClick: false });
    expect(resolveRegion("overlay.menu")).toBe(second.host);
    second.dismiss();
    expect(resolveRegion("overlay.menu")).toBe(first.host);
    first.dismiss();
  });

  test("a dialog slot stamps `overlay.dialog` while it is up", async () => {
    const { initLayers, showDialog } = await import("../src/ui/layers");
    initLayers();
    let done: ((v: string) => void) | null = null;
    const pending = showDialog<string>((resolve) => {
      done = resolve;
      return html`<p>asking</p>`;
    });
    expect(resolveRegion("overlay.dialog")).not.toBeNull();
    done!("ok");
    await pending;
    expect(resolveRegion("overlay.dialog")).toBeNull();
  });
});

// ─── The FocusRegion enum, now answerable ─────────────────────────────────────

describe("focus regions resolve against the live shell", () => {
  test("every value shell.ts declares points at a real node once mounted", async () => {
    const { mountShell, unmountShell } = await import("../src/shell");
    const { REGION_FOR_FOCUS } = await import("../src/ui/regions");
    mountShell();
    try {
      // `dock` is the Bottom dock, which does not exist yet — the id is minted, the node is not.
      for (const focus of ["rail", "navigator", "pane", "inspector", "status"] as const) {
        expect(resolveRegion(REGION_FOR_FOCUS[focus])).not.toBeNull();
      }
    } finally {
      unmountShell();
    }
  });
});
