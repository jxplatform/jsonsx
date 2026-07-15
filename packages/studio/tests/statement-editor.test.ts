// oxlint-disable unicorn/no-thenable -- `then` is the JSON Schema conditional keyword (spec §20), not a promise
/** Tests for src/panels/statement-editor.ts — structured function body (spec §20) editing UI. */
import "./harness";
import { describe, expect, test } from "bun:test";
import { render } from "lit-html";
import {
  laneListAt,
  renderStatementEditor,
  statementKind,
  withLaneList,
} from "../src/panels/statement-editor";

import type { JxStatement } from "@jxsuite/schema/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_OPTS = { allowEventRef: true, stateDefs: ["count", "items"] };

function mount(statements: JxStatement[], opts: Record<string, unknown> = {}) {
  const changes: JxStatement[][] = [];
  const container = document.createElement("div");
  render(
    renderStatementEditor(statements, (next) => changes.push(next), {
      ...DEFAULT_OPTS,
      ...opts,
    } as never),
    container,
  );
  return { changes, container };
}

function changeValue(el: Element, value: string) {
  (el as unknown as { value: string }).value = value;
  el.dispatchEvent(new Event("change", { bubbles: false }));
}

function inputValue(el: Element, value: string) {
  (el as unknown as { value: string }).value = value;
  el.dispatchEvent(new Event("input", { bubbles: false }));
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function cards(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll(".statement-card")] as HTMLElement[];
}

function addPickers(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll("sp-picker.statement-add")] as HTMLElement[];
}

// ─── statementKind ───────────────────────────────────────────────────────────

describe("statementKind", () => {
  test("discriminates the four kinds in runtime order", () => {
    expect(statementKind({ operator: "=", target: null })).toBe("expression");
    expect(statementKind({ if: null, then: [] })).toBe("if");
    expect(statementKind({ $switch: null, cases: {} })).toBe("switch");
    expect(statementKind({ dispatchEvent: "x" })).toBe("dispatch");
  });

  test("operator wins when a node also carries branch-like keys", () => {
    expect(statementKind({ if: 1, operator: "=", target: null })).toBe("expression");
  });

  test("non-objects and unknown shapes fall back to expression", () => {
    expect(statementKind(null)).toBe("expression");
    expect(statementKind("x")).toBe("expression");
    expect(statementKind({})).toBe("expression");
  });
});

// ─── laneListAt / withLaneList ───────────────────────────────────────────────

describe("lane addressing", () => {
  const tree: JxStatement[] = [
    { operator: "=", target: { $ref: "#/state/count" }, value: 1 },
    {
      else: [{ dispatchEvent: "no" }],
      if: { $ref: "#/state/count" },
      then: [{ dispatchEvent: "yes" }],
    },
    {
      $switch: { $ref: "#/state/count" },
      cases: { a: [{ dispatchEvent: "a" }] },
      default: [{ dispatchEvent: "d" }],
    },
  ];

  test("empty path resolves the root list", () => {
    expect(laneListAt(tree, [])).toBe(tree);
  });

  test("resolves then/else/cases/default lanes", () => {
    expect(laneListAt(tree, [1, "then"])).toEqual([{ dispatchEvent: "yes" }]);
    expect(laneListAt(tree, [1, "else"])).toEqual([{ dispatchEvent: "no" }]);
    expect(laneListAt(tree, [2, "cases", "a"])).toEqual([{ dispatchEvent: "a" }]);
    expect(laneListAt(tree, [2, "default"])).toEqual([{ dispatchEvent: "d" }]);
  });

  test("stale or invalid paths resolve to null", () => {
    expect(laneListAt(tree, [9, "then"])).toBeNull();
    expect(laneListAt(tree, [0, "then"])).toBeNull();
    expect(laneListAt(tree, [1, "bogus"])).toBeNull();
    expect(laneListAt(tree, [2, "cases", "missing"])).toBeNull();
    expect(laneListAt(tree, ["then", 1])).toBeNull();
  });

  test("withLaneList replaces a nested lane immutably", () => {
    const before = structuredClone(tree);
    const next = withLaneList(tree, [1, "then"], []);
    expect(tree).toEqual(before);
    expect(next).not.toBe(tree);
    expect((next[1] as { then: JxStatement[] }).then).toEqual([]);
    // Untouched siblings keep their identity
    expect(next[0]).toBe(tree[0]);
    expect(next[2]).toBe(tree[2]);
  });

  test("withLaneList replaces a case lane without disturbing other keys", () => {
    const next = withLaneList(tree, [2, "cases", "a"], [{ dispatchEvent: "z" }]);
    const sw = next[2] as { cases: Record<string, JxStatement[]>; default: JxStatement[] };
    expect(sw.cases.a).toEqual([{ dispatchEvent: "z" }]);
    expect(sw.default).toEqual([{ dispatchEvent: "d" }]);
  });

  test("withLaneList with the empty path returns the replacement list", () => {
    expect(withLaneList(tree, [], [])).toEqual([]);
  });
});

// ─── Rendering each statement kind ───────────────────────────────────────────

describe("renderStatementEditor structure", () => {
  test("renders one card per statement with kind labels and data attributes", () => {
    const { container } = mount([
      { operator: "=", target: { $ref: "#/state/count" }, value: 1 },
      { operator: "call", target: { $ref: "#/state/save" }, value: [] },
      { operator: "push", target: { $ref: "#/state/items" }, value: 1 },
      { if: { $ref: "#/state/count" }, then: [] },
      { $switch: { $ref: "#/state/count" }, cases: {} },
      { dispatchEvent: "saved" },
    ]);
    const labels = [...container.querySelectorAll(".statement-kind-label")].map((el) =>
      el.textContent!.trim(),
    );
    expect(labels).toEqual([
      "Set state",
      "Call",
      "Expression",
      "If / Else",
      "Switch",
      "Dispatch event",
    ]);
    const kinds = cards(container).map((c) => c.dataset.stmtKind);
    expect(kinds).toEqual(["expression", "expression", "expression", "if", "switch", "dispatch"]);
    // Top-level rows are addressed at the root lane
    expect(cards(container)[0]!.dataset.stmtLane).toBe("[]");
    expect(cards(container)[5]!.dataset.stmtIndex).toBe("5");
  });

  test("every card has a drag handle and a delete button", () => {
    const { container } = mount([{ dispatchEvent: "x" }]);
    const card = cards(container)[0]!;
    expect(card.querySelector(".statement-drag-handle")).toBeTruthy();
    expect(card.querySelector(".statement-delete")).toBeTruthy();
  });

  test("expression card embeds the expression editor", () => {
    const { container } = mount([{ operator: "=", target: { $ref: "#/state/count" }, value: 1 }]);
    expect(container.querySelector(".statement-card .expression-editor")).toBeTruthy();
  });

  test("if card renders test operand row, then lane, and add-else affordance", () => {
    const { container } = mount([{ if: { $ref: "#/state/count" }, then: [] }]);
    expect(container.querySelector('[data-prop="if"]')).toBeTruthy();
    const laneLabels = [...container.querySelectorAll(".statement-lane-header span")].map((s) =>
      s.textContent!.trim(),
    );
    expect(laneLabels).toContain("Then");
    expect(container.querySelector(".statement-add-else")).toBeTruthy();
  });

  test("if card with else renders the else lane with a remove button instead", () => {
    const { container } = mount([{ else: [], if: { $ref: "#/state/count" }, then: [] }]);
    const laneLabels = [...container.querySelectorAll(".statement-lane-header span")].map((s) =>
      s.textContent!.trim(),
    );
    expect(laneLabels).toContain("Else");
    expect(container.querySelector(".statement-add-else")).toBeNull();
    expect(container.querySelector(".statement-lane-remove")).toBeTruthy();
  });

  test("switch card renders discriminant, case lanes, default lane, and add-case", () => {
    const { container } = mount([
      { $switch: { $ref: "#/state/count" }, cases: { a: [{ dispatchEvent: "x" }] } },
    ]);
    expect(container.querySelector('[data-prop="$switch"]')).toBeTruthy();
    const caseKey = container.querySelector(".statement-case-key") as HTMLElement & {
      value: string;
    };
    expect(caseKey.value).toBe("a");
    const laneLabels = [...container.querySelectorAll(".statement-lane-header span")].map((s) =>
      s.textContent!.trim(),
    );
    expect(laneLabels).toContain("Default");
    expect(container.querySelector(".statement-add-case")).toBeTruthy();
    // The case's nested statement renders as a card in its lane
    const nested = cards(container)[1]!;
    expect(nested.dataset.stmtLane).toBe('[0,"cases","a"]');
  });

  test("dispatch card renders name field, detail operand, and init checkboxes", () => {
    const { container } = mount([{ dispatchEvent: "saved" }]);
    const name = container.querySelector(".statement-dispatch-name") as HTMLElement & {
      value: string;
    };
    expect(name.tagName.toLowerCase()).toBe("sp-textfield");
    expect(name.value).toBe("saved");
    expect(container.querySelector('[data-prop="detail"]')).toBeTruthy();
    expect(container.querySelector(".statement-dispatch-bubbles")).toBeTruthy();
    expect(container.querySelector(".statement-dispatch-composed")).toBeTruthy();
  });

  test("nested lanes use the border-left connector idiom", () => {
    const { container } = mount([{ if: { $ref: "#/state/count" }, then: [] }]);
    const lists = [...container.querySelectorAll(".statement-list")];
    expect(lists.length).toBe(2);
    for (const list of lists) {
      expect(list.getAttribute("style")).toContain("border-left");
    }
  });
});

// ─── Add-statement picker ────────────────────────────────────────────────────

describe("add statement", () => {
  test("offers the five kinds with ECMA/WHATWG labels", () => {
    const { container } = mount([]);
    const picker = addPickers(container)[0]!;
    const items = [...picker.querySelectorAll("sp-menu-item")];
    expect(items.map((i) => i.getAttribute("value"))).toEqual([
      "set",
      "call",
      "if",
      "switch",
      "dispatch",
    ]);
    expect(items.map((i) => i.textContent!.trim())).toEqual([
      "Set state",
      "Call function",
      "If / Else",
      "Switch",
      "Dispatch event",
    ]);
  });

  test.each([
    ["set", { operator: "=", target: { $ref: "" }, value: null }],
    ["call", { operator: "call", target: { $ref: "" }, value: [] }],
    ["if", { if: { operator: "===", target: { $ref: "" }, value: null }, then: [] }],
    ["switch", { $switch: { $ref: "" }, cases: {} }],
    ["dispatch", { dispatchEvent: "" }],
  ])("appends the %s seed (spec §20 shape)", (kind, seed) => {
    const existing: JxStatement[] = [{ dispatchEvent: "first" }];
    const { container, changes } = mount(existing);
    changeValue(addPickers(container).at(-1)!, kind as string);
    expect(changes[0]).toEqual([{ dispatchEvent: "first" }, seed as JxStatement]);
    // Immutable: the input list was not appended to
    expect(existing.length).toBe(1);
  });

  test("unknown picker value is a no-op", () => {
    const { container, changes } = mount([]);
    changeValue(addPickers(container)[0]!, "bogus");
    expect(changes.length).toBe(0);
  });

  test("adding inside a then lane writes through the branch statement", () => {
    const stmt: JxStatement = { if: { $ref: "#/state/count" }, then: [] };
    const { container, changes } = mount([stmt]);
    // The lane's picker renders before the top-level one
    changeValue(addPickers(container)[0]!, "dispatch");
    expect(changes[0]).toEqual([{ if: { $ref: "#/state/count" }, then: [{ dispatchEvent: "" }] }]);
    expect((stmt as { then: JxStatement[] }).then.length).toBe(0);
  });
});

// ─── Editing writes through immutably ────────────────────────────────────────

describe("statement editing", () => {
  test("expression edits replace only that statement", () => {
    const statements: JxStatement[] = [
      { operator: "=", target: { $ref: "#/state/count" }, value: 1 },
      { dispatchEvent: "keep" },
    ];
    const before = structuredClone(statements);
    const { container, changes } = mount(statements);
    const opPicker = cards(container)[0]!.querySelector('[data-prop="operator"] sp-picker')!;
    changeValue(opPicker, "+=");
    expect(changes[0]).toEqual([
      { operator: "+=", target: { $ref: "#/state/count" }, value: 1 },
      { dispatchEvent: "keep" },
    ]);
    expect(statements).toEqual(before);
    expect(changes[0]![1]).toBe(statements[1]!);
  });

  test("if test operand edits write through the if key", () => {
    const { container, changes } = mount([{ if: { $ref: "#/state/count" }, then: [] }]);
    // The operand mode picker is the row's first picker — switch the test to a literal
    changeValue(container.querySelector('[data-prop="if"] sp-picker')!, "literal");
    expect(changes[0]).toEqual([{ if: null, then: [] }]);
  });

  test("add else seeds an empty lane; remove else drops the key", () => {
    const { container, changes } = mount([{ if: { $ref: "#/state/count" }, then: [] }]);
    click(container.querySelector(".statement-add-else")!);
    expect(changes[0]).toEqual([{ else: [], if: { $ref: "#/state/count" }, then: [] }]);

    const withElse = mount([{ else: [], if: { $ref: "#/state/count" }, then: [] }]);
    click(withElse.container.querySelector(".statement-lane-remove")!);
    expect(withElse.changes[0]).toEqual([{ if: { $ref: "#/state/count" }, then: [] }]);
  });

  test("editing a nested statement inside a then lane writes through", () => {
    const { container, changes } = mount([
      { if: { $ref: "#/state/count" }, then: [{ dispatchEvent: "old" }] },
    ]);
    const nested = cards(container)[1]!;
    inputValue(nested.querySelector(".statement-dispatch-name")!, "new");
    expect(changes[0]).toEqual([
      { if: { $ref: "#/state/count" }, then: [{ dispatchEvent: "new" }] },
    ]);
  });

  test("switch discriminant edits write through $switch", () => {
    const { container, changes } = mount([{ $switch: { $ref: "#/state/count" }, cases: {} }]);
    const modePicker = container.querySelector('[data-prop="$switch"] sp-picker')!;
    changeValue(modePicker, "literal");
    expect(changes[0]).toEqual([{ $switch: null, cases: {} }]);
  });

  test("case rename preserves order and lane contents; same-key rename is a no-op", () => {
    const casesStmt: JxStatement = {
      $switch: { $ref: "#/state/count" },
      cases: { a: [{ dispatchEvent: "x" }], b: [] },
    };
    const { container, changes } = mount([casesStmt]);
    const keyField = container.querySelector(".statement-case-key")!;
    changeValue(keyField, "a");
    expect(changes.length).toBe(0);
    changeValue(keyField, "z");
    expect(changes[0]).toEqual([
      { $switch: { $ref: "#/state/count" }, cases: { b: [], z: [{ dispatchEvent: "x" }] } },
    ]);
    const keys = Object.keys((changes[0]![0] as { cases: object }).cases);
    expect(keys).toEqual(["z", "b"]);
  });

  test("add case generates a fresh key; case remove deletes it", () => {
    const { container, changes } = mount([
      { $switch: { $ref: "#/state/count" }, cases: { "case 2": [] } },
    ]);
    click(container.querySelector(".statement-add-case")!);
    expect(changes[0]).toEqual([
      { $switch: { $ref: "#/state/count" }, cases: { "case 2": [], "case 3": [] } },
    ]);

    click(container.querySelector(".statement-lane-remove")!);
    expect(changes[1]).toEqual([{ $switch: { $ref: "#/state/count" }, cases: {} }]);
  });

  test("adding to the default lane creates the key; emptying it removes the key", () => {
    const { container, changes } = mount([{ $switch: { $ref: "#/state/count" }, cases: {} }]);
    changeValue(addPickers(container)[0]!, "dispatch");
    expect(changes[0]).toEqual([
      { $switch: { $ref: "#/state/count" }, cases: {}, default: [{ dispatchEvent: "" }] },
    ]);

    const withDefault = mount([
      { $switch: { $ref: "#/state/count" }, cases: {}, default: [{ dispatchEvent: "d" }] },
    ]);
    click(cards(withDefault.container)[1]!.querySelector(".statement-delete")!);
    expect(withDefault.changes[0]).toEqual([{ $switch: { $ref: "#/state/count" }, cases: {} }]);
  });

  test("delete button removes exactly that top-level statement", () => {
    const { container, changes } = mount([
      { dispatchEvent: "one" },
      { dispatchEvent: "two" },
      { dispatchEvent: "three" },
    ]);
    click(cards(container)[1]!.querySelector(".statement-delete")!);
    expect(changes[0]).toEqual([{ dispatchEvent: "one" }, { dispatchEvent: "three" }]);
  });
});

// ─── Dispatch statement specifics ────────────────────────────────────────────

describe("dispatch statement", () => {
  test("offers declared emits names in a combobox", () => {
    const { container } = mount([{ dispatchEvent: "" }], {
      emits: [{ name: "cart-changed" }, { name: "saved" }, { name: "" }],
    });
    const combo = container.querySelector(".statement-dispatch-name")!;
    expect(combo.tagName.toLowerCase()).toBe("sp-combobox");
    const names = [...combo.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"));
    expect(names).toEqual(["cart-changed", "saved"]);
    changeValue(combo, "saved");
  });

  test("combobox change commits the event name", () => {
    const { container, changes } = mount([{ dispatchEvent: "" }], {
      emits: [{ name: "saved" }],
    });
    changeValue(container.querySelector(".statement-dispatch-name")!, "saved");
    expect(changes[0]).toEqual([{ dispatchEvent: "saved" }]);
  });

  test("plain textfield commits typed names when no emits are declared", () => {
    const { container, changes } = mount([{ dispatchEvent: "" }]);
    inputValue(container.querySelector(".statement-dispatch-name")!, "custom-event");
    expect(changes[0]).toEqual([{ dispatchEvent: "custom-event" }]);
  });

  test("detail operand edits write the detail key", () => {
    const { container, changes } = mount([{ dispatchEvent: "x" }]);
    const modePicker = container.querySelector('[data-prop="detail"] sp-picker')!;
    changeValue(modePicker, "ref");
    expect(changes[0]).toEqual([{ detail: { $ref: "" }, dispatchEvent: "x" }]);
  });

  test("bubbles/composed check on sets true; uncheck removes the key (WHATWG defaults)", () => {
    const { container, changes } = mount([{ dispatchEvent: "x" }]);
    const bubbles = container.querySelector(".statement-dispatch-bubbles")!;
    (bubbles as unknown as { checked: boolean }).checked = true;
    bubbles.dispatchEvent(new Event("change", { bubbles: false }));
    expect(changes[0]).toEqual([{ bubbles: true, dispatchEvent: "x" }]);

    const on = mount([{ bubbles: true, composed: true, dispatchEvent: "x" }]);
    const composed = on.container.querySelector(".statement-dispatch-composed")!;
    (composed as unknown as { checked: boolean }).checked = false;
    composed.dispatchEvent(new Event("change", { bubbles: false }));
    expect(on.changes[0]).toEqual([{ bubbles: true, dispatchEvent: "x" }]);
  });
});
