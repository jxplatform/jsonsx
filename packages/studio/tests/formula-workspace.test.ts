/**
 * ⑪ · Logic — the formula workspace (`panels/formula-workspace.ts`).
 *
 * It no longer takes over the canvas: P8.5 moves it into the Bottom dock's Logic tab so the page
 * whose values it computes stays on screen beside it. These tests render {@link logicPanelBody} —
 * the tab's body, exactly as `panels/bottom-dock.ts` calls it — and assert what the surface is:
 * chips with live badges, the recursive expression form for the chip-selected sub-node, the data
 * column, the root result, and a Close that clears the target. Edits immutably replace the selected
 * sub-node inside the root and write the whole node back through `transactDoc`, so undo restores
 * the previous tree. The wiring into the dock (reveal, strip, `afterRender`) is
 * `tests/bottom-dock.test.ts`.
 */
import { flush, pointer, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { render as litRender } from "lit-html";
import { initShellRefs } from "../src/store";
import { activeCanvasSurface } from "../src/canvas/canvas-surface";
import { undo } from "../src/tabs/transact";
import { view } from "../src/view";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { shell } from "../src/shell";
import {
  closeFormulaWorkspace,
  formulaRoot,
  logicPanelBody,
  logicTarget,
  openLogicTarget,
  revealLogicPanel,
} from "../src/panels/formula-workspace";

import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

/* The panels of the FOCUSED pane's stage. Panels belong to a pane's surface now, not to the
   app (`src/canvas/canvas-surface.ts`); the array identity is stable, so a module-level
   binding still sees what the render mutated. */
const canvasPanels = activeCanvasSurface().panels;

document.body.innerHTML = `<div id="app"><div id="canvas-wrap"></div><div id="logic"></div></div>`;
initShellRefs();

// Destructuring store.canvasWrap would snapshot the pre-initShellRefs null — query instead.
const canvasWrap = document.querySelector("#canvas-wrap") as HTMLElement;
/** Stands in for the dock's `.bd-body`: the element the Logic tab's body is rendered into. */
const dock = document.querySelector("#logic") as HTMLElement;

function docFixture(): JxMutableNode {
  return {
    children: [
      {
        onclick: {
          $expression: { operator: "+=", target: { $ref: "#/state/count" }, value: 1 },
        },
        tagName: "button",
        textContent: "Add",
      },
    ],
    state: {
      count: { default: 2, type: "integer" },
      mathArgs: {
        $expression: {
          operator: "call",
          target: { $ref: "window#/Math/max" },
          value: [{ operator: "+", target: 1, value: 2 }, 5],
        },
      },
      total: {
        $expression: {
          operator: "*",
          target: { operator: "+", target: { $ref: "#/state/count" }, value: 1 },
          value: 10,
        },
      },
    },
    tagName: "div",
  } as unknown as JxMutableNode;
}

/** Paint the Logic tab's body into the stand-in dock host, exactly as the dock does. */
function renderLogic() {
  litRender(logicPanelBody(renderLogic), dock);
}

/** Open a fixture tab with a canvas dataScope snapshot and a workspace target. */
function openWorkspace(
  editing?: Record<string, unknown> | null,
  scope?: Record<string, unknown> | null,
): Tab {
  const tab = resetWorkspaceWithTab(docFixture(), { id: "fw-tab" });
  tab.session.canvas.scope = scope === undefined ? { count: 2 } : scope;
  tab.session.ui.editingFormula = (
    editing === undefined ? { defName: "total", type: "def" } : editing
  ) as never;
  renderLogic();
  return tab;
}

function chipByTitle(title: string): HTMLElement {
  const chip = [...dock.querySelectorAll(".formula-chip")].find(
    (c) => c.getAttribute("title") === title,
  );
  if (!chip) {
    throw new Error(`no chip titled "${title}"`);
  }
  return chip as HTMLElement;
}

/** The selected sub-node form's operator picker. */
function operatorPicker(): HTMLElement & { value: string } {
  const picker = dock.querySelector(".fw-editor .expression-editor sp-picker");
  if (!picker) {
    throw new Error("no operator picker in the editor pane");
  }
  return picker as HTMLElement & { value: string };
}

function changeValue(el: HTMLElement & { value: string }, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function docState(): Record<string, never> {
  return (activeTab.value?.doc.document.state ?? {}) as Record<string, never>;
}

beforeEach(() => {
  resetStudioState();
  dock.textContent = "";
  // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
  delete dock["_$litPart$"];
  canvasWrap.textContent = "";
  // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
  delete canvasWrap["_$litPart$"];
});

// ─── Layout ───────────────────────────────────────────────────────────────────

describe("def-type target", () => {
  test("renders header, chips with live badges, editor form, data column, and result", () => {
    openWorkspace();

    expect(dock.querySelector(".formula-workspace")).not.toBeNull();
    expect(dock.querySelector(".fw-title")?.textContent).toContain("total");

    // Chip pipeline: head operand (count), then the + and * operator links.
    const chips = [...dock.querySelectorAll(".formula-chip")];
    expect(chips.map((c) => c.getAttribute("title"))).toEqual(["count", "+", "*"]);
    // Live badges from the dataScope snapshot: count=2 → 2, 3, 30 along the chain.
    const badges = [...dock.querySelectorAll(".fw-chips .expr-live-badge")];
    expect(badges.map((b) => b.textContent?.trim())).toEqual(["2", "3", "30"]);

    // Main pane: the selected sub-node form (root by default).
    expect(dock.querySelector(".fw-editor .expression-editor")).not.toBeNull();
    expect(dock.querySelector(".fw-selected")?.textContent).toContain("root");
    expect(operatorPicker().value).toBe("*");

    // The data column: the dataScope snapshot tree.
    const rail = dock.querySelector(".fw-context") as HTMLElement;
    expect(rail.textContent).toContain("count");
    expect(rail.querySelector(".data-tree")).not.toBeNull();

    // Footer: the root result badge.
    expect(dock.querySelector(".fw-result")?.textContent).toContain("= 30");

    // Header affordances: catalog browser and Close.
    expect(dock.querySelector(".fw-browse-catalog")).not.toBeNull();
    expect(dock.querySelector(".fw-close")).not.toBeNull();
  });

  test("leaves the canvas alone — the page it computes is the whole point of the move", () => {
    const tab = resetWorkspaceWithTab(docFixture(), { id: "fw-tab" });
    const cleanups: string[] = [];
    view.canvasDndCleanups = [() => cleanups.push("dnd")];
    view.canvasEventCleanups = [() => cleanups.push("event")];
    canvasPanels.push({ ready: true } as never);
    canvasWrap.textContent = "the rendered page";

    tab.session.ui.editingFormula = { defName: "total", type: "def" } as never;
    renderLogic();

    // The takeover cleared all four of these before drawing itself over the stage. Nothing here
    // Touches them, which is what keeps the canvas mounted, patchable and on screen.
    expect(cleanups).toEqual([]);
    expect(view.canvasDndCleanups).toHaveLength(1);
    expect(view.canvasEventCleanups).toHaveLength(1);
    expect(canvasPanels).toHaveLength(1);
    expect(canvasWrap.textContent).toBe("the rendered page");
    expect(dock.querySelector(".formula-workspace")).not.toBeNull();
  });

  test("renders the preview-unavailable footer and no badges without a scope snapshot", () => {
    openWorkspace({ defName: "total", type: "def" }, null);
    expect(dock.querySelector(".fw-result--pending")?.textContent).toContain("Preview unavailable");
    expect(dock.querySelector(".expr-live-badge")).toBeNull();
    expect(dock.querySelector(".fw-context")?.textContent).toContain("No canvas data snapshot yet");
  });

  test("renders the evaluation error in the footer", () => {
    const tab = openWorkspace();
    // An unknown operator makes the engine throw during preview.
    (docState().total! as { $expression: Record<string, unknown> }).$expression = {
      operator: "bogus",
      target: null,
    };
    tab.session.ui.editingFormula = { defName: "total", type: "def" } as never;
    renderLogic();
    expect(dock.querySelector(".fw-result--error")).not.toBeNull();
  });

  test("shows the empty state (with Close) when the target has no expression", () => {
    openWorkspace({ defName: "missing", type: "def" });
    expect(dock.querySelector(".empty-state")?.textContent).toContain("No expression found");
    expect(dock.querySelector(".fw-close")).not.toBeNull();
  });
});

// ─── Chip selection ───────────────────────────────────────────────────────────

describe("chip selection", () => {
  test("clicking an operator chip selects that sub-node in the form", () => {
    openWorkspace();
    pointer(chipByTitle("+"), "click");
    renderLogic();
    expect(operatorPicker().value).toBe("+");
    expect(dock.querySelector(".fw-selected")?.textContent).toContain("count › +");
  });

  test("clicking the head operand chip resolves to its enclosing operator node", () => {
    openWorkspace();
    pointer(chipByTitle("count"), "click");
    renderLogic();
    // The head chip targets a $ref operand; the nearest expression-node ancestor is the + link.
    expect(operatorPicker().value).toBe("+");
  });

  test("the selection does not carry across a retarget", () => {
    const tab = openWorkspace();
    pointer(chipByTitle("+"), "click");
    renderLogic();
    expect(operatorPicker().value).toBe("+");
    tab.session.ui.editingFormula = {
      eventKey: "onclick",
      path: ["children", 0],
      type: "event",
    } as never;
    renderLogic();
    // The stored selection is KEYED by target rather than reset during the render — a render that
    // Writes the state it reads is a reactive loop once the surface is an effect, which it is now.
    expect(operatorPicker().value).toBe("+=");
  });

  test("a selection kept for one target does not leak into another tab's identical one", () => {
    openWorkspace();
    pointer(chipByTitle("+"), "click");
    renderLogic();
    expect(operatorPicker().value).toBe("+");

    const other = resetWorkspaceWithTab(docFixture(), { id: "other-tab" });
    other.session.canvas.scope = { count: 2 };
    other.session.ui.editingFormula = { defName: "total", type: "def" } as never;
    renderLogic();
    expect(operatorPicker().value).toBe("*");
  });
});

// ─── Write-through ────────────────────────────────────────────────────────────

describe("editing", () => {
  test("editing a sub-node writes the whole root back and preserves the rest of the tree", () => {
    const tab = openWorkspace();
    pointer(chipByTitle("+"), "click");
    renderLogic();
    changeValue(operatorPicker(), "-");
    renderLogic();

    const expr = (docState().total! as { $expression: Record<string, unknown> }).$expression;
    // The selected sub-node changed…
    expect((expr.target as Record<string, unknown>).operator).toBe("-");
    // …while the untouched siblings/parents survived intact.
    expect(expr.operator).toBe("*");
    expect(expr.value).toBe(10);

    // The surface re-rendered against the updated document.
    expect(operatorPicker().value).toBe("-");

    // The write went through transactDoc: one undo step restores the previous tree.
    undo(tab);
    const restored = (docState().total! as { $expression: Record<string, unknown> }).$expression;
    expect((restored.target as Record<string, unknown>).operator).toBe("+");
    expect((restored.target as Record<string, unknown>).value).toBe(1);
  });

  test("picking a catalog entry replaces the selected sub-node", async () => {
    openWorkspace();
    pointer(dock.querySelector(".fw-browse-catalog") as HTMLElement, "click");
    await flush();
    const item = [...document.querySelectorAll(".quick-search-item")].find(
      (el) => el.querySelector(".quick-search-name")?.textContent === "?:",
    );
    expect(item).toBeTruthy();
    pointer(item!, "click");

    const expr = (docState().total! as { $expression: Record<string, unknown> }).$expression;
    expect(expr.operator).toBe("?:");
  });

  test("picking a packaged formula vendors its state def before inserting the call", async () => {
    openWorkspace();
    pointer(dock.querySelector(".fw-browse-catalog") as HTMLElement, "click");
    await flush();
    const item = [...document.querySelectorAll(".quick-search-item")].find(
      (el) => el.querySelector(".quick-search-name")?.textContent === "sum",
    );
    expect(item).toBeTruthy();
    pointer(item!, "click");

    // The packaged def was copied into document state (the project owns the copy)…
    const sum = docState().sum as { $expression?: unknown; parameters?: unknown[] } | undefined;
    expect(sum?.$expression).toBeTruthy();
    expect(Array.isArray(sum?.parameters)).toBe(true);
    // …and the selected node became a call to it.
    const expr = (docState().total! as { $expression: Record<string, unknown> }).$expression;
    expect(expr).toMatchObject({ operator: "call", target: { $ref: "#/state/sum" } });
  });

  test("editing a sub-node inside an array operand writes through the array index", () => {
    openWorkspace({ defName: "mathArgs", type: "def" });
    // The first call argument is an expression node → a parenthesized group chip.
    pointer(chipByTitle("(1 › +)"), "click");
    renderLogic();
    changeValue(operatorPicker(), "-");

    const expr = (docState().mathArgs! as { $expression: Record<string, unknown> }).$expression;
    const args = expr.value as Record<string, unknown>[];
    expect(args[0]!.operator).toBe("-");
    expect(args[0]!.target).toBe(1);
    // The sibling argument and the call node itself survived intact.
    expect(args[1]).toBe(5 as never);
    expect(expr.operator).toBe("call");
  });
});

// ─── Close ────────────────────────────────────────────────────────────────────

describe("close", () => {
  test("the Close button clears editingFormula", () => {
    const tab = openWorkspace();
    pointer(dock.querySelector(".fw-close") as HTMLElement, "click");
    expect(tab.session.ui.editingFormula).toBeNull();
  });

  test("with no target the tab says what it is for instead of painting a blank box", () => {
    const tab = openWorkspace();
    closeFormulaWorkspace();
    expect(tab.session.ui.editingFormula).toBeNull();
    renderLogic();
    expect(dock.querySelector(".formula-workspace")).toBeNull();
    expect(dock.textContent).toContain("Open a formula or a function to edit it here");
  });
});

// ─── The target, and the reveal ───────────────────────────────────────────────

describe("logicTarget", () => {
  test("is null with no tab and null with no target", () => {
    expect(logicTarget(null)).toBeNull();
    resetWorkspaceWithTab(docFixture(), { id: "fw-tab" });
    expect(logicTarget()).toBeNull();
  });

  test("the function editor wins when both fields are set", () => {
    const tab = openWorkspace();
    tab.session.ui.editingFunction = { defName: "count", type: "def" } as never;
    expect(logicTarget()?.surface).toBe("function");
    renderLogic();
    // One tab, two surfaces: the code container replaces the chip pipeline.
    expect(dock.querySelector(".fw-code")).not.toBeNull();
    expect(dock.querySelector(".fw-chips")).toBeNull();
    expect(dock.querySelector(".fw-title")?.textContent).toContain("count");
  });
});

describe("revealLogicPanel", () => {
  // The canvas no longer calls anything when a formula opens: it keeps rendering the page, and the
  // Dock reveals its own tab. This is the reveal itself, and the stage is untouched by it.
  test("selects the Logic tab, opens the dock, and leaves the stage alone", () => {
    openWorkspace();
    canvasWrap.textContent = "the rendered page";
    shell.bottomTab = "problems";
    shell.docks.bottom.collapsed = true;

    revealLogicPanel();

    expect(shell.bottomTab).toBe("logic");
    expect(shell.docks.bottom.collapsed).toBe(false);
    expect(canvasWrap.textContent).toBe("the rendered page");
  });
});

/**
 * The one WRITER of the two fields {@link logicTarget} reads, and therefore the one place the "one
 * tab, one target" rule can be kept. Every opener used to set its own field and leave the other
 * alone, and `logicTarget` gives the function editor the tie — so "Open in formula workspace" while
 * a Function body was open did nothing visible at all.
 */
describe("openLogicTarget", () => {
  test("opening a formula takes the target from an open function", () => {
    const tab = openWorkspace();
    tab.session.ui.editingFunction = { defName: "count", type: "def" } as never;
    expect(logicTarget()?.surface).toBe("function");

    openLogicTarget({ editing: { defName: "mathArgs", type: "def" }, surface: "formula" });

    expect(tab.session.ui.editingFunction).toBeNull();
    expect(tab.session.ui.editingFormula).toEqual({ defName: "mathArgs", type: "def" });
    expect(logicTarget()?.surface).toBe("formula");
    renderLogic();
    expect(dock.querySelector(".fw-title")?.textContent).toContain("mathArgs");
  });

  test("opening a function takes the target from an open formula", () => {
    const tab = openWorkspace();
    expect(logicTarget()?.surface).toBe("formula");

    openLogicTarget({
      editing: { eventKey: "onclick", path: ["children", 0], type: "event" },
      surface: "function",
    });

    expect(tab.session.ui.editingFormula).toBeNull();
    expect(logicTarget()?.surface).toBe("function");
  });

  test("reveals the surface itself, so a closed dock is not a dead click", () => {
    openWorkspace();
    shell.bottomTab = "problems";
    shell.docks.bottom.collapsed = true;

    // Same target the tab already holds: nothing CHANGES, so the dock's once-per-target effect has
    // Nothing to fire on. The gesture is a separate event and says so.
    openLogicTarget({ editing: { defName: "total", type: "def" }, surface: "formula" });

    expect(shell.bottomTab).toBe("logic");
    expect(shell.docks.bottom.collapsed).toBe(false);
  });

  test("is inert with no tab open rather than throwing", () => {
    closeAllTabs();
    expect(() =>
      openLogicTarget({ editing: { defName: "total", type: "def" }, surface: "formula" }),
    ).not.toThrow();
  });
});

// ─── Event-type target ────────────────────────────────────────────────────────

describe("event-type target", () => {
  test("resolves the element event binding's $expression and edits write through", () => {
    const tab = openWorkspace({ eventKey: "onclick", path: ["children", 0], type: "event" });

    expect(dock.querySelector(".fw-title")?.textContent).toContain("onclick");
    expect(operatorPicker().value).toBe("+=");

    changeValue(operatorPicker(), "=");
    const button = (tab.doc.document.children as Record<string, unknown>[])[0]!;
    const binding = button.onclick as { $expression: Record<string, unknown> };
    expect(binding.$expression.operator).toBe("=");
    expect(binding.$expression.value).toBe(1);
  });

  test("formulaRoot returns null for a non-expression binding", () => {
    const tab = openWorkspace();
    const editing = { eventKey: "onmissing", path: ["children", 0], type: "event" } as const;
    expect(formulaRoot(tab, editing as never)).toBeNull();
  });

  test("formulaRoot returns null when the target names neither a def nor a full event", () => {
    const tab = openWorkspace();
    // Def target without a defName, and an event target without a path — both fall through.
    expect(formulaRoot(tab, { type: "def" } as never)).toBeNull();
    expect(formulaRoot(tab, { eventKey: "onclick", type: "event" } as never)).toBeNull();
  });
});
