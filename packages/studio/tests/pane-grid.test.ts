import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  closeAllTabs,
  closePane,
  focusPane,
  openTab,
  splitRight,
  workspace,
} from "../src/workspace/workspace";
import { listRegions, resolveAllRegions, resolveRegion } from "../src/ui/regions";
import { DEFAULT_PANE_SPLIT, resetShellSurfaces, shell } from "../src/shell";
import { surfaceForPane } from "../src/canvas/surface-registry";
import { cellForPane, mount, paneCells, reconcile, unmount } from "../src/panels/pane-grid";

/**
 * The pane grid, as DOM.
 *
 * Three properties, and the first two are the ones no other gate can see:
 *
 * 1. **A cell is complete before it is published** (§18.1 rule 1). The stage, the strip and both
 *    region stamps exist in the same tick the `.pane` first appears in the document.
 * 2. **Reconciling twice does nothing.** The grid is driven by a reactive effect over
 *    `workspace.panes`, which re-runs for reasons that are not pane changes; a reconciler that
 *    rebuilt would throw away the canvas's lit render part and every live iframe with it.
 * 3. **Region ids are derived from the pane, and UNIQUE.** `pane.primary` used to be a row of the
 *    `SHELL_REGION_HOSTS` table pointing at `#canvas-wrap`. Sixty screenshots crop it and its two
 *    siblings. Each has to still resolve, to exactly one element, and to the PRIMARY cell's stage
 *    rather than to the whole cell or to the side pane's.
 */

function standUpGrid(): HTMLElement {
  document.body.innerHTML = `<div id="app"><div id="pane-grid"></div></div>`;
  return document.querySelector("#pane-grid") as HTMLElement;
}

beforeEach(() => {
  resetStudioState();
  closeAllTabs();
  shell.paneSplit = DEFAULT_PANE_SPLIT;
  standUpGrid();
  mount();
});

afterEach(() => {
  unmount();
  resetShellSurfaces();
  closeAllTabs();
});

describe("the cell", () => {
  test("the primary pane gets one cell, complete, with both region stamps", () => {
    const cell = cellForPane(PRIMARY_PANE);
    expect(cell).not.toBeNull();
    expect(cell!.root.isConnected).toBe(true);
    // Complete: the four surfaces are children of the root that was appended, not added after.
    expect([...cell!.root.children]).toEqual([cell!.strip, cell!.jump, cell!.chrome, cell!.stage]);
    expect(resolveRegion("pane.primary")).toBe(cell!.stage);
    expect(resolveRegion("pane.primary/tabs")).toBe(cell!.strip);
  });

  test("`pane.primary` names the STAGE, not the cell — widening it would widen nine shots", () => {
    const cell = cellForPane(PRIMARY_PANE)!;
    expect(resolveRegion("pane.primary")).not.toBe(cell.root);
    expect(cell.stage.classList.contains("pane-stage")).toBe(true);
  });

  test("the surface is registered against the stage before the cell is in the document", () => {
    const cell = cellForPane(PRIMARY_PANE)!;
    expect(surfaceForPane(PRIMARY_PANE).wrap).toBe(cell.stage);
    expect(surfaceForPane(PRIMARY_PANE).paneId).toBe(PRIMARY_PANE);
  });

  test("`pane` and `pane/x` still canonicalise onto the primary", () => {
    expect(resolveRegion("pane")).toBe(cellForPane(PRIMARY_PANE)!.stage);
    expect(resolveRegion("pane/tabs")).toBe(cellForPane(PRIMARY_PANE)!.strip);
  });
});

describe("reconcile", () => {
  test("is idempotent: a second pass performs no DOM operation at all", () => {
    /* Watched rather than mocked. `grid.append` was the only way in when the reconciler built its
       own nodes; lit inserts through `insertBefore`, so a mocked `append` would pass this test
       without ever proving anything. A subtree `childList` observer answers the real question —
       did the second pass touch one node — whichever call it would have used. */
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    const before = cellForPane(PRIMARY_PANE)!.root;
    const observer = new MutationObserver(() => {});
    observer.observe(grid, { childList: true, subtree: true });
    reconcile();
    reconcile();
    const touched = observer.takeRecords().length;
    observer.disconnect();
    expect(touched).toBe(0);
    expect(cellForPane(PRIMARY_PANE)!.root).toBe(before);
  });

  test("the stage element survives a reconcile, so the canvas keeps its lit render part", () => {
    const { stage } = cellForPane(PRIMARY_PANE)!;
    const marker = document.createElement("span");
    stage.append(marker);
    reconcile();
    expect(cellForPane(PRIMARY_PANE)!.stage).toBe(stage);
    expect(marker.isConnected).toBe(true);
  });

  test("a pane that leaves `workspace.panes` loses its cell and its surface record", async () => {
    resetWorkspaceWithTab();
    workspace.panes = [
      ...workspace.panes,
      { activeTabId: null, derived: null, id: "ghost", tabOrder: [] as string[] },
    ];
    await flush();
    const ghost = cellForPane("ghost");
    expect(ghost).not.toBeNull();
    expect(document.querySelectorAll(".pane")).toHaveLength(2);

    workspace.panes = workspace.panes.filter((pane) => pane.id !== "ghost");
    await flush();
    expect(cellForPane("ghost")).toBeNull();
    expect(ghost!.root.isConnected).toBe(false);
    expect(resolveAllRegions("pane.ghost")).toHaveLength(0);
    expect(document.querySelectorAll(".pane")).toHaveLength(1);
  });

  test("gaining a pane does not touch the cell that was already there", async () => {
    /* The load-bearing property of the reconciler. Re-parenting is not a move for an `<iframe>`:
       it reloads, which drops its `iframe-channel` connection, its shadow document and every panel
       that had reached `ready`. A grid that rebuilt on every pane change would blank the pane you
       were NOT splitting. */
    resetWorkspaceWithTab();
    const before = cellForPane(PRIMARY_PANE)!;
    const marker = document.createElement("span");
    before.stage.append(marker);
    const surface = surfaceForPane(PRIMARY_PANE);

    workspace.panes = [
      ...workspace.panes,
      { activeTabId: null, derived: null, id: SECONDARY_PANE, tabOrder: [] as string[] },
    ];
    await flush();

    expect(cellForPane(PRIMARY_PANE)).toBe(before);
    expect(cellForPane(PRIMARY_PANE)!.stage).toBe(before.stage);
    expect(marker.isConnected).toBe(true);
    expect(marker.parentElement).toBe(before.stage);
    expect(surfaceForPane(PRIMARY_PANE)).toBe(surface);
    expect(surface.wrap).toBe(before.stage);
  });
});

describe("the grid's own tracks", () => {
  test("one cell is one full-width track, and there is no splitter", () => {
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(grid.querySelector(".pane-splitter")).toBeNull();
  });

  test("`shell.paneSplit` clamps, and is inert while the grid is unsplit", () => {
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    shell.paneSplit = 0.3;
    reconcile();
    // Still one cell, so still one track: a restored split with nothing to split is harmless.
    expect(grid.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });
});

describe("unmount", () => {
  test("disposes every cell and forgets the grid", () => {
    const cell = cellForPane(PRIMARY_PANE)!;
    unmount();
    expect(cell.root.isConnected).toBe(false);
    expect(cellForPane(PRIMARY_PANE)).toBeNull();
    expect(resolveAllRegions("pane.primary")).toHaveLength(0);
    // Idempotent: mounting again after an unmount is what a project switch does.
    mount();
    expect(cellForPane(PRIMARY_PANE)).not.toBeNull();
  });

  test("mounting with no `#pane-grid` in the document is inert, not a throw", () => {
    unmount();
    document.body.innerHTML = "";
    expect(() => {
      mount();
    }).not.toThrow();
    expect(cellForPane(PRIMARY_PANE)).toBeNull();
    // And reconciling without a grid is a no-op rather than a null dereference.
    expect(() => {
      reconcile();
    }).not.toThrow();
  });
});

describe("the second cell", () => {
  /** Split the model and let the grid catch up. Returns the two cells, in grid order. */
  async function split() {
    resetWorkspaceWithTab();
    resetWorkspaceWithTab(undefined, { documentPath: "/project/other.json", id: "other" });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    await flush();
    return paneCells();
  }

  test("a split draws a second cell, complete, with its own stamps and its own surface", async () => {
    const cells = await split();
    expect(cells).toHaveLength(2);
    expect(cells.map((cell) => cell.paneId)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);

    const side = cellForPane(SECONDARY_PANE)!;
    expect(side.root.isConnected).toBe(true);
    expect([...side.root.children]).toEqual([side.strip, side.jump, side.chrome, side.stage]);
    expect(resolveRegion("pane.secondary")).toBe(side.stage);
    expect(resolveRegion("pane.secondary/tabs")).toBe(side.strip);
    // Its own surface record, registered against its own stage.
    expect(surfaceForPane(SECONDARY_PANE).wrap).toBe(side.stage);
    expect(surfaceForPane(SECONDARY_PANE).wrap).not.toBe(cellForPane(PRIMARY_PANE)!.stage);
  });

  test("the four ids THIS module stamps resolve to exactly ONE element each", async () => {
    /* Uniqueness is the load-bearing invariant of the whole family: `resolveRegion` takes the LAST
       match, so two elements carrying `pane.primary` is not an error — it is a silently wrong
       answer, and the sixty shots that crop `pane.primary` and `pane.primary/tabs` would
       photograph the SIDE pane without anything going red.

       Scoped to what this module emits, and named rather than swept. The sweep used to run over
       `listRegions()` on a bare `#pane-grid` and its comment cited `pane.primary/context` — an id
       that is never in this DOM, because `panels/pane-context.ts` is not mounted here. A sweep is
       only as strong as the renderers standing in the document, and the version of it that mounts
       every pane-scoped renderer at once lives in `pane-regions.test.ts`. */
    await split();
    const stamped = ["pane.primary", "pane.secondary", "pane.primary/tabs", "pane.secondary/tabs"];
    for (const id of stamped) {
      expect(resolveAllRegions(id)).toHaveLength(1);
      expect(listRegions()).toContain(id);
    }
    // And nothing else in this DOM is ambiguous either.
    expect(
      listRegions().filter((id) => !id.startsWith("overlay") && resolveAllRegions(id).length !== 1),
    ).toEqual([]);
  });

  test("`pane.primary` still names the PRIMARY cell's stage, which is why no shot moved", async () => {
    await split();
    expect(resolveRegion("pane.primary")).toBe(cellForPane(PRIMARY_PANE)!.stage);
    expect(resolveRegion("pane.primary/tabs")).toBe(cellForPane(PRIMARY_PANE)!.strip);
    expect(resolveRegion("pane")).toBe(cellForPane(PRIMARY_PANE)!.stage);
  });

  test("two tracks and a splitter between them, sized from `shell.paneSplit`", async () => {
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    const cells = await split();
    expect(grid.style.gridTemplateColumns).toBe("minmax(0, 0.5fr) 5px minmax(0, 0.5fr)");

    const splitter = grid.querySelector(".pane-splitter");
    expect(splitter).not.toBeNull();
    // BETWEEN them: the splitter sits after the first cell and before the second.
    expect(splitter!.previousElementSibling).toBe(cells[0]!.root);
    expect(splitter!.nextElementSibling).toBe(cells[1]!.root);

    shell.paneSplit = 0.7;
    reconcile();
    expect(grid.style.gridTemplateColumns).toBe(`minmax(0, 0.7fr) 5px minmax(0, ${1 - 0.7}fr)`);
  });

  test("the splitter drags the ratio, clamps at a usable pane, and double-click restores 50/50", async () => {
    /* One dragger, not a third one: `ui/panel-resize.ts`'s `setupHandle` — the same capture,
       dragging class, text-selection suppression, double-click reset and one-persist-on-release
       the three dock handles use. A dock is sized in px and a split is a RATIO, which is the whole
       of the difference, and `scale` is the one field that expresses it: the drag converts a
       pointer delta in px into the target's own units, so the same layout survives a window
       resize. The ratio lives on `shell.paneSplit` — pure LAYOUT, naming no tab, no document and no
       pane identity — and persists with the dock widths through `persistDocks`. */
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 1000 });
    await split();
    const splitter = grid.querySelector(".pane-splitter") as HTMLElement;

    const drag = (from: number, to: number) => {
      splitter.dispatchEvent(new PointerEvent("pointerdown", { clientX: from, clientY: 0 }));
      splitter.dispatchEvent(new PointerEvent("pointermove", { clientX: to, clientY: 0 }));
      splitter.dispatchEvent(new PointerEvent("pointerup", { clientX: to, clientY: 0 }));
    };

    // 150px right of centre, over a 1000px grid, is +0.15 of the ratio.
    drag(500, 650);
    expect(shell.paneSplit).toBeCloseTo(0.65, 5);
    expect(splitter.classList.contains("dragging")).toBe(false);
    reconcile();
    expect(grid.style.gridTemplateColumns).toBe("minmax(0, 0.65fr) 5px minmax(0, 0.35fr)");

    // The floor is a PANE, not a sliver: 320px of a 1000px grid, on both sides, symmetrically.
    drag(500, -5000);
    expect(shell.paneSplit).toBeCloseTo(0.32, 5);
    drag(500, 5000);
    expect(shell.paneSplit).toBeCloseTo(0.68, 5);

    splitter.dispatchEvent(new MouseEvent("dblclick"));
    expect(shell.paneSplit).toBe(DEFAULT_PANE_SPLIT);
  });

  test("the splitter is built once and re-used across reconciles", async () => {
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    await split();
    const splitter = grid.querySelector(".pane-splitter");
    reconcile();
    reconcile();
    expect(grid.querySelectorAll(".pane-splitter")).toHaveLength(1);
    expect(grid.querySelector(".pane-splitter")).toBe(splitter);
  });

  test("a multi-step drag never removes the handle from the grid — not once", async () => {
    /* The splitter used to be positioned by `cells[1].root.before(_splitter)`, re-run from
       `layout()`. `layout()` runs on every `shell.paneSplit` write, which is every `pointermove` of
       the drag — and `.before()` on an already-positioned node is a REMOVE plus an insert. In
       Chrome that fires `lostpointercapture` on move #1, the rest of the gesture goes to whatever
       is under the cursor, and a drag asking for +0.20 lands +0.03.
       Zero childList mutations on the grid is the structural statement: a node that is never
       removed cannot lose its capture. It is true because the splitter is part of the template now
       — lit commits it once, and a re-render with unchanged bindings writes no DOM at all. */
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 1000 });
    await split();
    const splitter = grid.querySelector(".pane-splitter") as HTMLElement;

    const observer = new MutationObserver(() => {});
    observer.observe(grid, { childList: true });

    splitter.dispatchEvent(new PointerEvent("pointerdown", { clientX: 500, clientY: 0 }));
    for (const clientX of [520, 560, 600, 640, 660]) {
      splitter.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY: 0 }));
    }
    splitter.dispatchEvent(new PointerEvent("pointerup", { clientX: 660, clientY: 0 }));

    // Drained synchronously: the whole gesture is synchronous, so nothing has to be waited for —
    // And waiting would let the cells' scheduled canvas renders in, whose DOM is not the subject.
    const records = observer.takeRecords();
    observer.disconnect();
    /* Compared as NAMES, never as nodes. `expect(nodes).toEqual([])` on a failure hands bun's diff
       printer a live happy-dom element to serialize, and it does not come back — the regression
       this test guards would have looked like a hung test run rather than a red one.
       Built with `push` rather than `flatMap` + spread: `oxc(no-map-spread)` refuses the spread
       inside the callback and `unicorn(prefer-spread)` refuses `Array.from`, so this is the one
       spelling both rules accept — and it is the one the first rule's own help text names. */
    const name = (node: Node) =>
      node instanceof Element ? `${node.nodeName.toLowerCase()}.${node.className}` : node.nodeName;
    const removed: string[] = [];
    const added: string[] = [];
    for (const record of records) {
      for (const node of record.removedNodes) {
        removed.push(name(node));
      }
      for (const node of record.addedNodes) {
        added.push(name(node));
      }
    }

    expect(removed).toEqual([]);
    expect(added).toEqual([]);
    // The whole drag landed, not the first move's worth of it. 660 of a 1000px grid is +0.16 on the
    // Ratio, inside the 320px-a-side floor that caps this grid's drag at 0.68.
    expect(shell.paneSplit).toBeCloseTo(0.66, 5);
    expect(grid.querySelector(".pane-splitter")).toBe(splitter);
    expect(splitter.isConnected).toBe(true);
  });

  test("unsplitting takes the second cell away and the splitter with it", async () => {
    await split();
    const side = cellForPane(SECONDARY_PANE)!;
    closePane(SECONDARY_PANE);
    await flush();

    expect(cellForPane(SECONDARY_PANE)).toBeNull();
    expect(side.root.isConnected).toBe(false);
    expect(resolveAllRegions("pane.secondary")).toHaveLength(0);
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    expect(grid.querySelector(".pane-splitter")).toBeNull();
    expect(grid.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    // And the survivor is untouched, still holding its own stage.
    expect(surfaceForPane(PRIMARY_PANE).wrap).toBe(cellForPane(PRIMARY_PANE)!.stage);
  });
});

describe("a pointer in a cell moves the keyboard into it", () => {
  const doc = () => ({ children: [{ tagName: "p", textContent: "x" }], tagName: "div" });

  async function split() {
    closeAllTabs();
    openTab({ document: doc(), documentPath: "/project/left.json", id: "left" });
    openTab({ document: doc(), documentPath: "/project/right.json", id: "right" });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    await flush();
    // `splitRight` leaves the NEW pane focused, so put the keyboard back in the primary: every
    // Assertion below is about a pointer landing in the pane the keyboard is NOT in.
    focusPane(PRIMARY_PANE);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
  }

  const down = (el: Element) => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  };

  test("every surface in the side cell focuses it — not only its tab strip", async () => {
    /* `panels/tab-strip.ts`'s strip row was the ONLY thing in the app that moved
       `workspace.activePaneId` by pointer. Clicking the side pane's canvas, its context bar, its
       jump bar or anything drawn into its stage left the keyboard in the primary, so the
       Inspector, the block action bar, the overlay effect and every keyboard command went on
       answering for a document the person was not looking at. */
    await split();
    const side = cellForPane(SECONDARY_PANE)!;
    for (const [name, el] of [
      ["stage", side.stage],
      ["chrome", side.chrome],
      ["jump", side.jump],
      ["root", side.root],
    ] as const) {
      focusPane(PRIMARY_PANE);
      down(el);
      expect(`${name}: ${workspace.activePaneId}`).toBe(`${name}: ${SECONDARY_PANE}`);
    }
  });

  test("a pointer deep INSIDE a cell counts — the listener is on the cell, not on each surface", async () => {
    await split();
    const side = cellForPane(SECONDARY_PANE)!;
    const deep = document.createElement("button");
    side.chrome.append(deep);
    down(deep);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
  });

  test("a handler that stops propagation cannot take the pane's focus with it", async () => {
    /* Capture phase, so a control inside the cell that swallows the event — a picker, a drag
       start — cannot leave the keyboard in the other pane. */
    await split();
    const side = cellForPane(SECONDARY_PANE)!;
    const swallow = document.createElement("button");
    swallow.addEventListener("pointerdown", (e) => e.stopPropagation());
    side.chrome.append(swallow);
    down(swallow);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
  });

  test("the SPLITTER is not in a cell, so a drag on it never moves focus", async () => {
    /* The one interaction that must not be disturbed mid-gesture. It is a sibling of the cells in
       the grid rather than a child of either, so the listener structurally cannot see it. */
    await split();
    const grid = document.querySelector("#pane-grid") as HTMLElement;
    const splitter = grid.querySelector(".pane-splitter") as HTMLElement;
    expect(splitter.closest(".pane")).toBeNull();
    down(splitter);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
  });

  test("a pointer in the pane that already has focus changes nothing at all", async () => {
    /* `focusPane` is called on every pointerdown now, so it has to be free when it has nothing to
       do: `promoteMru` rewrites the order `⌃Tab` walks and `resetTabCycle` abandons a live walk
       through it. Clicking around in the pane you are already in must not touch either. */
    await split();
    const primary = cellForPane(PRIMARY_PANE)!;
    workspace.mruOrder = ["right", "left"];
    down(primary.stage);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.mruOrder).toEqual(["right", "left"]);
  });
});
