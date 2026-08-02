import "./harness";
import { describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { expressionHint, renderExpressionEditor } from "../src/ui/expression-editor";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_OPTS = { allowEventRef: false, stateDefs: ["count", "items"] };

function mount(node: unknown, opts: Record<string, unknown> = {}) {
  const changes: unknown[] = [];
  const container = document.createElement("div");
  render(
    renderExpressionEditor(node, (n) => changes.push(n), {
      ...DEFAULT_OPTS,
      ...opts,
    } as never),
    container,
  );
  return { changes, container };
}

/** Set a control's value property and fire a change event (lit listener target = el). */
function changeValue(el: Element, value: string) {
  (el as unknown as { value: string }).value = value;
  el.dispatchEvent(new Event("change", { bubbles: false }));
}

function inputValue(el: Element, value: string) {
  (el as unknown as { value: string }).value = value;
  el.dispatchEvent(new Event("input", { bubbles: false }));
}

function row(container: HTMLElement, prop: string): HTMLElement {
  const el = container.querySelector(`[data-prop="${prop}"]`);
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

function pickerValue(el: Element | null): string {
  return (el as unknown as { value: string }).value;
}

// ─── expressionHint ──────────────────────────────────────────────────────────

describe("expressionHint", () => {
  test("non-object or missing operator falls back to $expression", () => {
    expect(expressionHint(null)).toBe("$expression");
    expect(expressionHint("=")).toBe("$expression");
    expect(expressionHint({})).toBe("$expression");
    expect(expressionHint({ operator: 5 })).toBe("$expression");
  });

  test("assignment ops show op + ref label without #/state/ prefix", () => {
    expect(expressionHint({ operator: "=", target: { $ref: "#/state/count" } })).toBe("= count");
    expect(expressionHint({ operator: "+=", target: { $ref: "#/state/total" } })).toBe("+= total");
  });

  test("one-arg array ops show op + target", () => {
    expect(expressionHint({ operator: "push", target: { $ref: "#/state/items" } })).toBe(
      "push items",
    );
  });

  test("no-arg array ops render as a call", () => {
    expect(expressionHint({ operator: "pop", target: { $ref: "#/state/items" } })).toBe(
      "pop(items)",
    );
    expect(expressionHint({ operator: "shift", target: { $ref: "#/state/items" } })).toBe(
      "shift(items)",
    );
  });

  test("splice renders as splice(target)", () => {
    expect(expressionHint({ operator: "splice", target: { $ref: "#/state/items" } })).toBe(
      "splice(items)",
    );
  });

  test("aggregate ops render as op(target)", () => {
    expect(expressionHint({ operator: "reduce", target: { $ref: "#/state/items" } })).toBe(
      "reduce(items)",
    );
    expect(expressionHint({ operator: "map", target: { $ref: "#/state/items" } })).toBe(
      "map(items)",
    );
    expect(expressionHint({ operator: "filter", target: { $ref: "#/state/items" } })).toBe(
      "filter(items)",
    );
  });

  test("unary ops prefix the target", () => {
    expect(expressionHint({ operator: "!", target: { $ref: "#/state/flag" } })).toBe("!flag");
  });

  test("binary ops render target op ellipsis", () => {
    expect(expressionHint({ operator: "+", target: 5 })).toBe("5 + …");
  });

  test("nested expression target renders as (op…)", () => {
    expect(expressionHint({ operator: "=", target: { operator: "+", target: 1 } })).toBe("= (+…)");
  });

  test("null/undefined target renders as ?", () => {
    expect(expressionHint({ operator: "<", target: null })).toBe("? < …");
    expect(expressionHint({ operator: "<" })).toBe("? < …");
  });

  test("unknown operator falls through to binary-style hint", () => {
    expect(expressionHint({ operator: "frobnicate", target: "x" })).toBe("x frobnicate …");
  });

  test("call renders as callee(…) with pointer prefixes stripped", () => {
    expect(expressionHint({ operator: "call", target: { $ref: "#/state/lineTotal" } })).toBe(
      "lineTotal(…)",
    );
    expect(expressionHint({ operator: "call", target: { $ref: "window#/Math/max" } })).toBe(
      "Math.max(…)",
    );
  });

  test("conditional renders as test ? … : … and switch as switch(target)", () => {
    expect(expressionHint({ operator: "?:", target: { $ref: "#/state/flag" } })).toBe(
      "flag ? … : …",
    );
    expect(expressionHint({ operator: "switch", target: { $ref: "#/state/kind" } })).toBe(
      "switch(kind)",
    );
  });
});

// ─── Structure per operator category ─────────────────────────────────────────

describe("renderExpressionEditor structure", () => {
  test("null node defaults to assignment with ref target and value row", () => {
    const { container } = mount(null);
    expect(pickerValue(row(container, "operator").querySelector("sp-picker"))).toBe("=");
    // Assignment target must be a ref → single ref picker, no mode picker
    const targetPickers = row(container, "target").querySelectorAll("sp-picker");
    expect(targetPickers.length).toBe(1);
    // Value row exists (assignment needs a value)
    expect(container.querySelector('[data-prop="value"]')).toBeTruthy();
  });

  test("non-object node string also falls back to assignment defaults", () => {
    const { container } = mount("garbage");
    expect(pickerValue(row(container, "operator").querySelector("sp-picker"))).toBe("=");
  });

  test("depth 0 has no nesting border, nested expression target does", () => {
    const { container } = mount({ operator: "+", target: { operator: "-", target: 4 }, value: 1 });
    const editors = container.querySelectorAll(".expression-editor");
    expect(editors.length).toBe(2);
    expect(editors[0]!.getAttribute("style") ?? "").not.toContain("border-left");
    expect(editors[1]!.getAttribute("style")).toContain("border-left");
  });

  test("explicit depth > 0 applies the nesting border on the root", () => {
    const { container } = mount({ operator: "!", target: null }, { depth: 2 });
    const editor = container.querySelector(".expression-editor")!;
    expect(editor.getAttribute("style")).toContain("border-left");
  });

  test("unary operator renders no value row", () => {
    const { container } = mount({ operator: "!", target: null });
    expect(container.querySelector('[data-prop="value"]')).toBeNull();
  });

  test("binary operator renders mode picker for target and a value row", () => {
    const { container } = mount({ operator: "+", target: 1, value: 2 });
    const targetPickers = row(container, "target").querySelectorAll("sp-picker");
    // Mode picker + literal type picker
    expect(targetPickers.length).toBe(2);
    expect(pickerValue(targetPickers[0]!)).toBe("literal");
    expect(container.querySelector('[data-prop="value"]')).toBeTruthy();
  });

  test("pop renders ref-only target and no value row", () => {
    const { container } = mount({ operator: "pop", target: { $ref: "#/state/items" } });
    expect(row(container, "target").querySelectorAll("sp-picker").length).toBe(1);
    expect(container.querySelector('[data-prop="value"]')).toBeNull();
  });

  test("splice renders args editor instead of plain value row", () => {
    const { container } = mount({
      operator: "splice",
      target: { $ref: "#/state/items" },
      value: [null],
    });
    expect(container.querySelector(".array-object-field")).toBeTruthy();
  });

  test("reduce renders per-item nested editor and an initial row", () => {
    const { container } = mount({
      initial: 0,
      operator: "reduce",
      target: { $ref: "#/state/items" },
      value: { operator: "+", target: { $ref: "#/state/acc" }, value: 1 },
    });
    expect(container.querySelectorAll(".expression-editor").length).toBe(2);
    expect(container.querySelector('[data-prop="initial"]')).toBeTruthy();
  });

  test("map without a value node shows the default ! nested editor", () => {
    const { container } = mount({ operator: "map", target: { $ref: "#/state/items" } });
    const nested = container.querySelectorAll(".expression-editor")[1]!;
    expect(pickerValue(nested.querySelector('[data-prop="operator"] sp-picker'))).toBe("!");
    expect(container.querySelector('[data-prop="initial"]')).toBeNull();
  });

  test("zero-arg pure methods render no value row; argument-taking ones do", () => {
    const zero = mount({ operator: "toUpperCase", target: { $ref: "#/state/name" } });
    expect(zero.container.querySelector('[data-prop="value"]')).toBeNull();

    const one = mount({ operator: "split", target: { $ref: "#/state/name" }, value: "," });
    expect(one.container.querySelector('[data-prop="value"]')).toBeTruthy();
    // The receiver is any operand (not ref-only) → mode picker + ref picker
    expect(row(one.container, "target").querySelectorAll("sp-picker").length).toBe(2);
  });

  test("depth-0 preview error renders above the form", () => {
    const { container } = mount(
      { operator: "+", target: 1, value: 2 },
      { preview: { error: "boom: bad operand", mutating: false, values: new Map() } },
    );
    const editor = container.querySelector(".expression-editor")!;
    expect(editor.textContent).toContain("boom: bad operand");
  });

  test("operator menu offers call under a Function group", () => {
    const { container } = mount(null);
    const values = [...row(container, "operator").querySelectorAll("sp-menu-item")].map((i) =>
      i.getAttribute("value"),
    );
    expect(values).toContain("call");
    const headers = [...row(container, "operator").querySelectorAll("sp-menu-group span")].map(
      (s) => s.textContent,
    );
    expect(headers).toContain("Function");
  });
});

// ─── Call operator ───────────────────────────────────────────────────────────

describe("call operator", () => {
  const STATE_ENTRIES = {
    lineTotal: {
      $expression: {
        operator: "*",
        target: { $ref: "$args/price" },
        value: { $ref: "$args/qty" },
      },
      parameters: [{ name: "price" }, { default: 1, name: "qty" }],
    },
  };

  function argLabels(container: HTMLElement): string[] {
    return [...container.querySelectorAll(".array-object-row > span")].map((s) =>
      s.textContent!.trim(),
    );
  }

  test("renders a Callee ref-only row and the positional args editor", () => {
    const { container } = mount(
      { operator: "call", target: { $ref: "#/state/lineTotal" }, value: [2, 3] },
      { stateEntries: STATE_ENTRIES },
    );
    const target = row(container, "target");
    expect(target.textContent).toContain("Callee");
    // Callee must be a ref → single ref picker, no mode picker
    expect(target.querySelectorAll("sp-picker").length).toBe(1);
    expect(container.querySelector(".array-object-field")).not.toBeNull();
    // Arg labels come from the named formula's catalog entry
    expect(argLabels(container)).toEqual(["price", "qty"]);
  });

  test("unresolvable callee falls back to the generic arg label", () => {
    const { container } = mount({
      operator: "call",
      target: { $ref: "#/state/missing" },
      value: [1],
    });
    expect(argLabels(container)).toEqual(["arg"]);
  });

  test("editing an arg replaces only that index", () => {
    const { container, changes } = mount(
      { operator: "call", target: { $ref: "#/state/lineTotal" }, value: [2, 3] },
      { stateEntries: STATE_ENTRIES },
    );
    const rows = container.querySelectorAll(".array-object-row");
    changeValue(rows[1]!.querySelector("sp-number-field")!, "9");
    expect(changes[0]).toEqual({
      operator: "call",
      target: { $ref: "#/state/lineTotal" },
      value: [2, 9],
    });
  });

  test("switching operator to call seeds a ref target and empty args array", () => {
    const { container, changes } = mount({ operator: "+", target: 1, value: 2 });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "call");
    expect(changes[0]).toEqual({ operator: "call", target: { $ref: "" }, value: [] });
  });

  test("switching to call keeps an existing args array and ref target", () => {
    const { container, changes } = mount({
      operator: "call",
      target: { $ref: "#/state/lineTotal" },
      value: [1],
    });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "call");
    expect(changes[0]).toEqual({
      operator: "call",
      target: { $ref: "#/state/lineTotal" },
      value: [1],
    });
  });
});

// ─── Chips strip (depth 0) ───────────────────────────────────────────────────

describe("chips strip", () => {
  test("renders once at depth 0 above the form, not in nested editors", () => {
    const { container } = mount({ operator: "+", target: { operator: "-", target: 4 }, value: 1 });
    const strips = container.querySelectorAll(".formula-chips");
    expect(strips.length).toBe(1);
    const editors = container.querySelectorAll(".expression-editor");
    expect(strips[0]!.closest(".expression-editor")).toBe(editors[0]!);
  });

  test("does not render when the editor starts at a nested depth", () => {
    const { container } = mount({ operator: "!", target: null }, { depth: 1 });
    expect(container.querySelector(".formula-chips")).toBeNull();
  });

  test("clicking a chip invokes the onChipSelect hook with the node path", () => {
    const picks: unknown[] = [];
    const { container, changes } = mount(
      { operator: "!", target: { $ref: "#/state/count" } },
      { onChipSelect: (p: unknown) => picks.push(p) },
    );
    const chip = container.querySelector(".formula-chip") as HTMLElement;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(picks).toEqual([["target"]]);
    expect(changes.length).toBe(0);
  });

  test("chip clicks are a no-op without the hook", () => {
    const { container, changes } = mount({ operator: "!", target: null });
    container
      .querySelector(".formula-chip")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(changes.length).toBe(0);
  });
});

// ─── Browse catalog affordance ───────────────────────────────────────────────

describe("browse catalog", () => {
  test("button beside the operator picker opens the palette; picking inserts the entry", () => {
    const { container, changes } = mount({ operator: "+", target: 1, value: 2 });
    const btn = row(container, "operator").querySelector(".expr-browse-catalog") as HTMLElement;
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".formula-palette-overlay")).not.toBeNull();

    const item = [...document.querySelectorAll(".quick-search-item")].find(
      (i) => i.querySelector(".quick-search-name")?.textContent === "?:",
    )!;
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(changes[0]).toEqual({ initial: null, operator: "?:", target: null, value: null });
    expect(document.querySelector(".formula-palette-overlay")).toBeNull();
  });

  test("palette includes named formulas when stateEntries are provided", () => {
    const { container } = mount(
      { operator: "+", target: 1, value: 2 },
      {
        stateEntries: {
          lineTotal: {
            $expression: { operator: "*", target: { $ref: "$args/a" }, value: 2 },
            parameters: ["a"],
          },
        },
      },
    );
    const btn = row(container, "operator").querySelector(".expr-browse-catalog") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const names = [...document.querySelectorAll(".quick-search-name")].map((n) => n.textContent);
    expect(names).toContain("lineTotal");
    document
      .querySelector(".formula-palette-overlay")!
      .dispatchEvent(new MouseEvent("click", { bubbles: false }));
    expect(document.querySelector(".formula-palette-overlay")).toBeNull();
  });
});

// ─── Ref picker ──────────────────────────────────────────────────────────────

describe("ref picker", () => {
  test("lists state refs with prefix stripped from labels", () => {
    const { container } = mount({ operator: "=", target: { $ref: "#/state/count" } });
    const items = [...row(container, "target").querySelectorAll("sp-menu-item")];
    expect(items.map((i) => i.getAttribute("value"))).toEqual(["#/state/count", "#/state/items"]);
    expect(items[0]!.textContent!.trim()).toBe("count");
  });

  test("nothing to bind to → the shared empty state replaces the picker entirely", () => {
    const { container } = mount({ operator: "=", target: { $ref: "" } }, { stateDefs: [] });
    const target = row(container, "target");
    // A picker whose only entry was a disabled "No state defined" was a dead end; the region now
    // Says what a binding IS, in the same voice as every other empty region in the shell.
    expect(target.querySelector("sp-picker[placeholder='Select…']")).toBeNull();
    const empty = target.querySelector(".empty-state")!;
    expect(empty.classList.contains("empty-state--compact")).toBe(true);
    expect(empty.querySelector(".empty-state-message")?.textContent).toBe(
      "A binding points at a value this page holds.",
    );
    expect(empty.querySelector(".empty-state-detail")?.textContent).toBe(
      "Add one in the State panel and it shows up here.",
    );
  });

  test("no state but event refs available → the picker still renders, with no dead entry", () => {
    const { container } = mount(
      { operator: "=", target: { $ref: "" } },
      { allowEventRef: true, stateDefs: [] },
    );
    const target = row(container, "target");
    expect(target.querySelector(".empty-state")).toBeNull();
    const values = [...target.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"));
    expect(values).toEqual(["event#/detail", "event#/target/value"]);
  });

  test("an existing ref keeps the picker even with no state defined", () => {
    const { container } = mount(
      { operator: "=", target: { $ref: "#/state/gone" } },
      { stateDefs: [] },
    );
    const target = row(container, "target");
    expect(target.querySelector(".empty-state")).toBeNull();
    expect(target.querySelector("sp-picker")).not.toBeNull();
  });

  test("allowEventRef adds event refs after a divider", () => {
    const { container } = mount({ operator: "=", target: { $ref: "" } }, { allowEventRef: true });
    const target = row(container, "target");
    expect(target.querySelector("sp-menu-divider")).toBeTruthy();
    const values = [...target.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"));
    expect(values).toContain("event#/detail");
    expect(values).toContain("event#/target/value");
  });

  test("custom ref value displays as __custom__ and change to __custom__ is a no-op", () => {
    const { container, changes } = mount({ operator: "=", target: { $ref: "#/weird/path" } });
    const picker = row(container, "target").querySelector("sp-picker")!;
    expect(pickerValue(picker)).toBe("__custom__");
    changeValue(picker, "__custom__");
    expect(changes.length).toBe(0);
  });

  test("selecting a ref emits an updated target", () => {
    const { container, changes } = mount({
      operator: "=",
      target: { $ref: "#/state/count" },
      value: null,
    });
    changeValue(row(container, "target").querySelector("sp-picker")!, "#/state/items");
    expect(changes[0]).toEqual({
      operator: "=",
      target: { $ref: "#/state/items" },
      value: null,
    });
  });
});

// ─── Operator change handler ─────────────────────────────────────────────────

describe("operator change", () => {
  test("switching to push coerces a non-ref target to an empty ref and adds value", () => {
    const { container, changes } = mount({ operator: "=", target: null });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "push");
    expect(changes[0]).toEqual({ operator: "push", target: { $ref: "" }, value: null });
  });

  test("switching keeps an existing ref target and value", () => {
    const { container, changes } = mount({
      operator: "=",
      target: { $ref: "#/state/count" },
      value: 5,
    });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "+=");
    expect(changes[0]).toEqual({ operator: "+=", target: { $ref: "#/state/count" }, value: 5 });
  });

  test("switching to splice seeds value with [null] when not an array", () => {
    const { container, changes } = mount({
      operator: "=",
      target: { $ref: "#/state/items" },
      value: "x",
    });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "splice");
    expect(changes[0]).toEqual({
      operator: "splice",
      target: { $ref: "#/state/items" },
      value: [null],
    });
  });

  test("switching to splice keeps an existing array value", () => {
    const { container, changes } = mount({
      operator: "splice",
      target: { $ref: "#/state/items" },
      value: [0, 1],
    });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "splice");
    expect(changes[0]).toEqual({
      operator: "splice",
      target: { $ref: "#/state/items" },
      value: [0, 1],
    });
  });

  test("switching to reduce seeds a node value and initial", () => {
    const { container, changes } = mount({
      operator: "=",
      target: { $ref: "#/state/items" },
      value: 3,
    });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "reduce");
    expect(changes[0]).toEqual({
      initial: 0,
      operator: "reduce",
      target: { $ref: "#/state/items" },
      value: { operator: "!", target: null },
    });
  });

  test("switching to reduce keeps existing node value and initial", () => {
    const { container, changes } = mount({
      initial: 7,
      operator: "map",
      target: { $ref: "#/state/items" },
      value: { operator: "+", target: 1, value: 2 },
    });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "reduce");
    expect(changes[0]).toEqual({
      initial: 7,
      operator: "reduce",
      target: { $ref: "#/state/items" },
      value: { operator: "+", target: 1, value: 2 },
    });
  });

  test("switching to a unary op drops value and initial", () => {
    const { container, changes } = mount({
      initial: 7,
      operator: "reduce",
      target: { $ref: "#/state/items" },
      value: { operator: "!", target: null },
    });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "!");
    expect(changes[0]).toEqual({ operator: "!", target: { $ref: "#/state/items" } });
  });

  test("switching to an unknown op produces a bare operator/target node", () => {
    const { container, changes } = mount({ operator: "+", target: 1, value: 2 });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "mystery");
    expect(changes[0]).toEqual({ operator: "mystery", target: 1 });
  });

  test("switching to switch seeds empty cases and drops value", () => {
    const { container, changes } = mount({ operator: "+", target: 1, value: 2 });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "switch");
    expect(changes[0]).toEqual({ cases: {}, operator: "switch", target: 1 });
  });

  test("switching to switch keeps existing cases and default", () => {
    const { container, changes } = mount({
      cases: { one: "a" },
      default: "d",
      operator: "switch",
      target: { $ref: "#/state/count" },
    });
    changeValue(row(container, "operator").querySelector("sp-picker")!, "switch");
    expect(changes[0]).toEqual({
      cases: { one: "a" },
      default: "d",
      operator: "switch",
      target: { $ref: "#/state/count" },
    });
  });
});

// ─── Operand mode picker ─────────────────────────────────────────────────────

describe("operand mode switching", () => {
  test("switching target mode to ref emits an empty ref", () => {
    const { container, changes } = mount({ operator: "+", target: 1, value: 2 });
    changeValue(row(container, "target").querySelectorAll("sp-picker")[0]!, "ref");
    expect(changes[0]).toEqual({ operator: "+", target: { $ref: "" }, value: 2 });
  });

  test("switching value mode to expression emits a default expression node", () => {
    const { container, changes } = mount({ operator: "+", target: 1, value: 2 });
    changeValue(row(container, "value").querySelectorAll("sp-picker")[0]!, "expression");
    expect(changes[0]).toEqual({
      operator: "+",
      target: 1,
      value: { operator: "!", target: null },
    });
  });

  test("switching mode to literal (or unknown) emits null", () => {
    const { container, changes } = mount({
      operator: "+",
      target: { $ref: "#/state/count" },
      value: 2,
    });
    const modePicker = row(container, "target").querySelectorAll("sp-picker")[0]!;
    expect(pickerValue(modePicker)).toBe("ref");
    changeValue(modePicker, "literal");
    expect(changes[0]).toEqual({ operator: "+", target: null, value: 2 });
    changeValue(modePicker, "bogus-mode");
    expect(changes[1]).toEqual({ operator: "+", target: null, value: 2 });
  });

  test("expression-mode operand renders a nested editor and propagates edits", () => {
    const { container, changes } = mount({
      operator: "+",
      target: { operator: "-", target: 4 },
      value: 1,
    });
    const targetRow = row(container, "target");
    expect(pickerValue(targetRow.querySelectorAll("sp-picker")[0]!)).toBe("expression");
    const nested = container.querySelectorAll(".expression-editor")[1]!;
    changeValue(nested.querySelector('[data-prop="operator"] sp-picker')!, "!");
    expect(changes[0]).toEqual({
      operator: "+",
      target: { operator: "!", target: 4 },
      value: 1,
    });
  });
});

// ─── Literal editor ──────────────────────────────────────────────────────────

describe("literal editor", () => {
  test("string literal renders a textfield and commits typed input", () => {
    const { container, changes } = mount({ operator: "+", target: "hello", value: null });
    const targetRow = row(container, "target");
    const tf = targetRow.querySelector("sp-textfield")!;
    expect(pickerValue(tf)).toBe("hello");
    inputValue(tf, "world");
    expect(changes[0]).toEqual({ operator: "+", target: "world", value: null });
  });

  test("number literal renders a number field and commits a number", () => {
    const { container, changes } = mount({ operator: "+", target: 5, value: null });
    const nf = row(container, "target").querySelector("sp-number-field")!;
    expect((nf as unknown as { value: number }).value).toBe(5);
    changeValue(nf, "7");
    expect(changes[0]).toEqual({ operator: "+", target: 7, value: null });
  });

  test("boolean literal renders a checkbox and commits checked state", () => {
    const { container, changes } = mount({ operator: "+", target: true, value: null });
    const cb = row(container, "target").querySelector("sp-checkbox")!;
    expect(cb.hasAttribute("checked")).toBe(true);
    (cb as unknown as { checked: boolean }).checked = false;
    cb.dispatchEvent(new Event("change", { bubbles: false }));
    expect(changes[0]).toEqual({ operator: "+", target: false, value: null });
  });

  test("object operand without $ref or operator falls back to the literal editor", () => {
    const { container } = mount({ operator: "+", target: {}, value: 1 });
    const modePicker = row(container, "target").querySelectorAll("sp-picker")[0]!;
    expect(pickerValue(modePicker)).toBe("literal");
    // A plain object has no dedicated widget — it stringifies into the string editor
    expect(row(container, "target").querySelector("sp-textfield")).toBeTruthy();
  });

  test("null literal renders the inert null label", () => {
    const { container } = mount({ operator: "+", target: null, value: 1 });
    const targetRow = row(container, "target");
    expect(targetRow.querySelector("sp-textfield")).toBeNull();
    const spans = [...targetRow.querySelectorAll("span")];
    expect(spans.some((s) => s.textContent!.trim() === "null")).toBe(true);
  });

  test("type picker switches emit the type defaults", () => {
    const { container, changes } = mount({ operator: "+", target: "x", value: null });
    const typePicker = row(container, "target").querySelectorAll("sp-picker")[1]!;
    expect(pickerValue(typePicker)).toBe("string");
    changeValue(typePicker, "number");
    changeValue(typePicker, "boolean");
    changeValue(typePicker, "null");
    changeValue(typePicker, "string");
    expect(changes.map((c) => (c as { target: unknown }).target)).toEqual([0, false, null, ""]);
  });
});

// ─── Splice args editor ──────────────────────────────────────────────────────

describe("splice args editor", () => {
  function mountSplice(value: unknown) {
    return mount({ operator: "splice", target: { $ref: "#/state/items" }, value });
  }

  test("labels rows start/del/item and falls back to item beyond three", () => {
    const { container } = mountSplice([null, 1, "a", "b"]);
    const rows = [...container.querySelectorAll(".array-object-row")];
    expect(rows.length).toBe(4);
    const labels = rows.map((r) => r.querySelector("span")!.textContent!.trim());
    expect(labels).toEqual(["start", "del", "item", "item"]);
  });

  test("editing an arg replaces only that index", () => {
    const { container, changes } = mountSplice([null, 1]);
    const rows = container.querySelectorAll(".array-object-row");
    changeValue(rows[1]!.querySelector("sp-number-field")!, "5");
    expect((changes[0] as { value: unknown[] }).value).toEqual([null, 5]);
  });

  test("delete button removes the arg", () => {
    const { container, changes } = mountSplice([0, 1, "a"]);
    const delBtn = container
      .querySelectorAll(".array-object-row")[0]!
      .querySelector("sp-action-button")!;
    delBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect((changes[0] as { value: unknown[] }).value).toEqual([1, "a"]);
  });

  test("deleting the last arg resets to [null]", () => {
    const { container, changes } = mountSplice(["only"]);
    const delBtn = container.querySelector(".array-object-row sp-action-button")!;
    delBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect((changes[0] as { value: unknown[] }).value).toEqual([null]);
  });

  test("add button appends a null arg", () => {
    const { container, changes } = mountSplice([0]);
    const buttons = [...container.querySelectorAll(".array-object-field sp-action-button")];
    const addBtn = buttons.at(-1)!;
    expect(addBtn.textContent).toContain("+ Add arg");
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect((changes[0] as { value: unknown[] }).value).toEqual([0, null]);
  });

  test("non-array value renders zero rows but still offers add", () => {
    const { container, changes } = mountSplice("not-an-array");
    expect(container.querySelectorAll(".array-object-row").length).toBe(0);
    const addBtn = container.querySelector(".array-object-field sp-action-button")!;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect((changes[0] as { value: unknown[] }).value).toEqual([null]);
  });
});

// ─── Per-item / initial editing for aggregates ───────────────────────────────

describe("aggregate value and initial editing", () => {
  test("editing the per-item expression propagates through value", () => {
    const { container, changes } = mount({
      initial: 0,
      operator: "reduce",
      target: { $ref: "#/state/items" },
      value: { operator: "!", target: null },
    });
    const nested = container.querySelectorAll(".expression-editor")[1]!;
    changeValue(nested.querySelector('[data-prop="operator"] sp-picker')!, "pop");
    expect(changes[0]).toEqual({
      initial: 0,
      operator: "reduce",
      target: { $ref: "#/state/items" },
      value: { operator: "pop", target: { $ref: "" } },
    });
  });

  test("editing initial via its number field propagates", () => {
    const { container, changes } = mount({
      initial: 0,
      operator: "reduce",
      target: { $ref: "#/state/items" },
      value: { operator: "!", target: null },
    });
    const nf = row(container, "initial").querySelector("sp-number-field")!;
    changeValue(nf, "42");
    expect((changes[0] as { initial: number }).initial).toBe(42);
  });
});

// ─── Switch cases editor ─────────────────────────────────────────────────────

describe("switch cases editor", () => {
  function mountSwitch(cases: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return mount({
      cases,
      default: null,
      operator: "switch",
      target: { $ref: "#/state/count" },
      ...extra,
    });
  }

  test("renders a key field per case, the default row, and add-case", () => {
    const { container } = mountSwitch({ a: { $ref: "#/state/count" }, b: null });
    const keys = [...container.querySelectorAll(".switch-cases sp-textfield")].map(
      (tf) => (tf as unknown as { value: string }).value,
    );
    expect(keys).toEqual(["a", "b"]);
    expect(container.querySelector(".switch-cases")!.textContent).toContain("default");
  });

  test("case rename preserves order and operands; same-key rename is a no-op", () => {
    const { container, changes } = mountSwitch({ a: { $ref: "#/state/count" }, b: null });
    const keyField = container.querySelector(".switch-cases sp-textfield")!;
    changeValue(keyField, "a");
    expect(changes.length).toBe(0);
    changeValue(keyField, "z");
    const { cases } = changes[0] as { cases: Record<string, unknown> };
    expect(cases).toEqual({ b: null, z: { $ref: "#/state/count" } });
    expect(Object.keys(cases)).toEqual(["z", "b"]);
  });

  test("editing a case operand writes through that key only", () => {
    const { container, changes } = mountSwitch({ a: 1, b: 2 });
    const firstRow = container.querySelector(".switch-cases > div")!;
    changeValue(firstRow.querySelector("sp-number-field")!, "9");
    expect((changes[0] as { cases: unknown }).cases).toEqual({ a: 9, b: 2 });
  });

  test("the delete button removes exactly that case", () => {
    const { container, changes } = mountSwitch({ a: 1, b: 2 });
    const delBtn = container.querySelector(".switch-cases sp-action-button")!;
    delBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect((changes[0] as { cases: unknown }).cases).toEqual({ b: 2 });
  });

  test("editing the default operand writes the default key", () => {
    const { container, changes } = mountSwitch({}, { default: 5 });
    const defaultRow = [...container.querySelectorAll(".switch-cases > div")].at(-1)!;
    changeValue(defaultRow.querySelector("sp-number-field")!, "7");
    expect((changes[0] as { default: number }).default).toBe(7);
  });

  test("add case generates a fresh key past collisions, seeded null", () => {
    const { container, changes } = mountSwitch({ "case 2": null });
    const addBtn = [...container.querySelectorAll(".switch-cases sp-action-button")].at(-1)!;
    expect(addBtn.textContent).toContain("+ Add case");
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // One existing entry → tries "case 2" (taken) → lands on "case 3"
    expect((changes[0] as { cases: unknown }).cases).toEqual({ "case 2": null, "case 3": null });
  });
});
