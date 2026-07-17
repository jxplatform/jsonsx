/**
 * Formula workspace tests (M4). The workspace takes over the canvas area (the renderFunctionEditor
 * precedent) for a single `$expression` identified by TabUi.editingFormula: chips with live badges
 * on top, the recursive expression form for the chip-selected sub-node in the main pane, the
 * dataScope snapshot rail on the right, and the root result footer. Edits immutably replace the
 * selected sub-node inside the root and write the whole node back through transactDoc, so undo
 * restores the previous tree.
 */
import { flush, pointer, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { canvasPanels, initShellRefs } from "../src/store";
import { undo } from "../src/tabs/transact";
import { view } from "../src/view";
import { activeTab } from "../src/workspace/workspace";
import {
  closeFormulaWorkspace,
  formulaRoot,
  renderFormulaWorkspace,
} from "../src/panels/formula-workspace";

import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

document.body.innerHTML = `<div id="app"><div id="canvas-wrap"></div></div>`;
initShellRefs();

// Destructuring store.canvasWrap would snapshot the pre-initShellRefs null — query instead.
const canvasWrap = document.querySelector("#canvas-wrap") as HTMLElement;

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
  renderFormulaWorkspace();
  return tab;
}

function chipByTitle(title: string): HTMLElement {
  const chip = [...canvasWrap.querySelectorAll(".formula-chip")].find(
    (c) => c.getAttribute("title") === title,
  );
  if (!chip) {
    throw new Error(`no chip titled "${title}"`);
  }
  return chip as HTMLElement;
}

/** The selected sub-node form's operator picker. */
function operatorPicker(): HTMLElement & { value: string } {
  const picker = canvasWrap.querySelector(".fw-editor .expression-editor sp-picker");
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
  canvasWrap.textContent = "";
  // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
  delete canvasWrap["_$litPart$"];
});

// ─── Layout ───────────────────────────────────────────────────────────────────

describe("def-type target", () => {
  test("renders header, chips with live badges, editor form, data rail, and result footer", () => {
    openWorkspace();

    expect(canvasWrap.querySelector(".formula-workspace")).not.toBeNull();
    expect(canvasWrap.querySelector(".fw-title")?.textContent).toContain("total");

    // Chip pipeline: head operand (count), then the + and * operator links.
    const chips = [...canvasWrap.querySelectorAll(".formula-chip")];
    expect(chips.map((c) => c.getAttribute("title"))).toEqual(["count", "+", "*"]);
    // Live badges from the dataScope snapshot: count=2 → 2, 3, 30 along the chain.
    const badges = [...canvasWrap.querySelectorAll(".fw-chips .expr-live-badge")];
    expect(badges.map((b) => b.textContent?.trim())).toEqual(["2", "3", "30"]);

    // Main pane: the selected sub-node form (root by default).
    expect(canvasWrap.querySelector(".fw-editor .expression-editor")).not.toBeNull();
    expect(canvasWrap.querySelector(".fw-selected")?.textContent).toContain("root");
    expect(operatorPicker().value).toBe("*");

    // Right rail: the dataScope snapshot tree.
    const rail = canvasWrap.querySelector(".fw-context") as HTMLElement;
    expect(rail.textContent).toContain("count");
    expect(rail.querySelector(".data-tree")).not.toBeNull();

    // Footer: the root result badge.
    expect(canvasWrap.querySelector(".fw-result")?.textContent).toContain("= 30");

    // Header affordances: catalog browser and Close.
    expect(canvasWrap.querySelector(".fw-browse-catalog")).not.toBeNull();
    expect(canvasWrap.querySelector(".fw-close")).not.toBeNull();
  });

  test("renders the preview-unavailable footer and no badges without a scope snapshot", () => {
    openWorkspace({ defName: "total", type: "def" }, null);
    expect(canvasWrap.querySelector(".fw-result--pending")?.textContent).toContain(
      "Preview unavailable",
    );
    expect(canvasWrap.querySelector(".expr-live-badge")).toBeNull();
    expect(canvasWrap.querySelector(".fw-context")?.textContent).toContain(
      "No canvas data snapshot yet",
    );
  });

  test("renders the evaluation error in the footer", () => {
    const tab = openWorkspace();
    // An unknown operator makes the engine throw during preview.
    (docState().total! as { $expression: Record<string, unknown> }).$expression = {
      operator: "bogus",
      target: null,
    };
    tab.session.ui.editingFormula = { defName: "total", type: "def" } as never;
    renderFormulaWorkspace();
    expect(canvasWrap.querySelector(".fw-result--error")).not.toBeNull();
  });

  test("shows the empty state (with Close) when the target has no expression", () => {
    openWorkspace({ defName: "missing", type: "def" });
    expect(canvasWrap.querySelector(".empty-state")?.textContent).toContain("No expression found");
    expect(canvasWrap.querySelector(".fw-close")).not.toBeNull();
  });
});

// ─── Chip selection ───────────────────────────────────────────────────────────

describe("chip selection", () => {
  test("clicking an operator chip selects that sub-node in the form", () => {
    openWorkspace();
    pointer(chipByTitle("+"), "click");
    expect(operatorPicker().value).toBe("+");
    expect(canvasWrap.querySelector(".fw-selected")?.textContent).toContain("count › +");
  });

  test("clicking the head operand chip resolves to its enclosing operator node", () => {
    openWorkspace();
    pointer(chipByTitle("count"), "click");
    // The head chip targets a $ref operand; the nearest expression-node ancestor is the + link.
    expect(operatorPicker().value).toBe("+");
  });

  test("the selection resets to root when the workspace retargets", () => {
    const tab = openWorkspace();
    pointer(chipByTitle("+"), "click");
    expect(operatorPicker().value).toBe("+");
    tab.session.ui.editingFormula = {
      eventKey: "onclick",
      path: ["children", 0],
      type: "event",
    } as never;
    renderFormulaWorkspace();
    expect(operatorPicker().value).toBe("+=");
  });
});

// ─── Write-through ────────────────────────────────────────────────────────────

describe("editing", () => {
  test("editing a sub-node writes the whole root back and preserves the rest of the tree", () => {
    const tab = openWorkspace();
    pointer(chipByTitle("+"), "click");
    changeValue(operatorPicker(), "-");

    const expr = (docState().total! as { $expression: Record<string, unknown> }).$expression;
    // The selected sub-node changed…
    expect((expr.target as Record<string, unknown>).operator).toBe("-");
    // …while the untouched siblings/parents survived intact.
    expect(expr.operator).toBe("*");
    expect(expr.value).toBe(10);

    // The workspace re-rendered against the updated document.
    expect(operatorPicker().value).toBe("-");

    // The write went through transactDoc: one undo step restores the previous tree.
    undo(tab);
    const restored = (docState().total! as { $expression: Record<string, unknown> }).$expression;
    expect((restored.target as Record<string, unknown>).operator).toBe("+");
    expect((restored.target as Record<string, unknown>).value).toBe(1);
  });

  test("picking a catalog entry replaces the selected sub-node", async () => {
    openWorkspace();
    pointer(canvasWrap.querySelector(".fw-browse-catalog") as HTMLElement, "click");
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
    pointer(canvasWrap.querySelector(".fw-browse-catalog") as HTMLElement, "click");
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
    pointer(canvasWrap.querySelector(".fw-close") as HTMLElement, "click");
    expect(tab.session.ui.editingFormula).toBeNull();
  });

  test("renderFormulaWorkspace is a no-op without a target", () => {
    const tab = openWorkspace();
    closeFormulaWorkspace();
    expect(tab.session.ui.editingFormula).toBeNull();
    canvasWrap.textContent = "";
    // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
    delete canvasWrap["_$litPart$"];
    renderFormulaWorkspace();
    expect(canvasWrap.querySelector(".formula-workspace")).toBeNull();
  });
});

// ─── Event-type target ────────────────────────────────────────────────────────

describe("event-type target", () => {
  test("resolves the element event binding's $expression and edits write through", () => {
    const tab = openWorkspace({ eventKey: "onclick", path: ["children", 0], type: "event" });

    expect(canvasWrap.querySelector(".fw-title")?.textContent).toContain("onclick");
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

// ─── Canvas takeover ──────────────────────────────────────────────────────────

describe("canvas takeover", () => {
  test("rendering runs and clears canvas DnD/event cleanups and panel registrations", () => {
    const calls: string[] = [];
    const tab = resetWorkspaceWithTab(docFixture(), { id: "fw-tab" });
    tab.session.canvas.scope = { count: 2 };
    tab.session.ui.editingFormula = { defName: "total", type: "def" } as never;
    view.canvasDndCleanups = [() => calls.push("dnd")];
    view.canvasEventCleanups = [() => calls.push("event")];
    canvasPanels.push({} as never);

    renderFormulaWorkspace();

    expect(calls).toEqual(["dnd", "event"]);
    expect(view.canvasDndCleanups).toEqual([]);
    expect(view.canvasEventCleanups).toEqual([]);
    expect(canvasPanels.length).toBe(0);
    expect(canvasWrap.querySelector(".formula-workspace")).not.toBeNull();
  });
});
