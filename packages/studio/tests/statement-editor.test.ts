// oxlint-disable unicorn/no-thenable -- `then` is the JSON Schema conditional keyword (spec §20), not a promise
/** Tests for src/panels/statement-editor.ts — structured function body (spec §20) editing UI. */
import { flush, stubRect } from "./harness";
import { describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";
import { emittedClassesOf, inlineStyledOwn, unstyledClassesOf } from "./styled-surface";
import { extractInstruction } from "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item";
import {
  laneListAt,
  renderStatementEditor,
  statementKind,
  withLaneList,
} from "../src/panels/statement-editor";
import {
  NAVIGATOR_STATEMENTS_REGION,
  inspectorStatementsRegion,
  resolveAllRegions,
  resolveRegion,
} from "../src/ui/regions";

import type { JxStatement } from "@jxsuite/schema/types";

// ─── DnD adapter mock ────────────────────────────────────────────────────────
/**
 * RegisterStatementsDnD imports the pragmatic-drag-and-drop element adapter dynamically inside its
 * rAF callback, so mocking here — after the static import of the module under test — still
 * intercepts every registration. The tree-item hitbox and combine stay real.
 */

type AnyRec = Record<string, any>;

const draggables: AnyRec[] = [];
const dropTargets: AnyRec[] = [];
const previewsDisabled: AnyRec[] = [];

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: (cfg: AnyRec) => {
    draggables.push(cfg);
    return () => {};
  },
  dropTargetForElements: (cfg: AnyRec) => {
    dropTargets.push(cfg);
    return () => {};
  },
}));

// The real helper is inert under the harness (its 1x1 image is only created when `window` exists
// At npm-module evaluation time, which precedes happy-dom registration) — record calls instead.
void mock.module("@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview", () => ({
  disableNativeDragPreview: (args: AnyRec) => {
    previewsDisabled.push(args);
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_OPTS = {
  allowEventRef: true,
  region: "navigator/statements",
  stateDefs: ["count", "items"],
};

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
    // The connector, the indent and the card frame are `.statement-list` / `.statement-card` rules
    // In styles/inspector.css — asserted as the class, because the rule is not in the markup.
    for (const list of lists) {
      expect(list.getAttribute("style")).toBeNull();
    }
  });
});

// ─── The layout is a stylesheet's, not an attribute's ────────────────────────

describe("every surface is addressable by CSS", () => {
  /*
   * The Logic tab shipped with no stylesheet at all: twenty class names in check-styles.ts's
   * ALLOWED_ORPHANS and a handful of inline `style="display:flex;…"` attributes doing the layout.
   * An attribute cannot carry `min-width: 0`, and a flex item's automatic minimum is its
   * min-content width, so an operand row asking for a 112px picker + a 56px picker + a Spectrum
   * field simply refused to shrink: in a 280px Inspector the Operator, Target and Value controls
   * were clipped by the right edge of the WINDOW.
   *
   * Under happy-dom nothing lays out, so these tests assert the two things that DO decide it — the
   * class is on the element, and the element carries no inline style to outrank the stylesheet.
   * The pixels were checked in Chrome instead, in the Navigator's State panel at 180 / 240 / 280 /
   * 420 / 600px: from 240px up, no descendant's right edge passes the panel's, and the operand rows
   * that sit side by side at 600px are stacked at 240px. Below ~200px the panel overflows already,
   * at `sp-accordion-item`, with these editors hidden — the signals panel's own rows, not this.
   */
  const EVERY_KIND: JxStatement[] = [
    { operator: "=", target: { $ref: "#/state/count" }, value: 1 },
    { else: [], if: { $ref: "#/state/count" }, then: [{ dispatchEvent: "x" }] },
    { $switch: { $ref: "#/state/count" }, cases: { a: [] }, default: [] },
    { dispatchEvent: "saved" },
  ];

  test("no element the editor names carries an inline style attribute", async () => {
    const { container } = mount(EVERY_KIND);
    const own = await emittedClassesOf("src/panels/statement-editor.ts");
    expect(inlineStyledOwn(container, own)).toEqual([]);
  });

  test("the card, its header and its body are all named", () => {
    const { container } = mount([{ dispatchEvent: "x" }]);
    const card = cards(container)[0]!;
    expect(card.querySelector(".statement-card-header")).toBeTruthy();
    expect(card.querySelector(".statement-card-body")).toBeTruthy();
    // The delete button is pushed right by `margin-left: auto`, not by a spacer element.
    expect(card.querySelector(".statement-card-header > span:not([class])")).toBeNull();
  });

  test("a lane's label is a class, and a case key is a field inside it", () => {
    const { container } = mount([
      { $switch: { $ref: "#/state/count" }, cases: { a: [] }, default: [] },
    ]);
    const labels = [...container.querySelectorAll(".statement-lane-label")];
    expect(labels.length).toBe(2);
    // The case key lives INSIDE the label slot, so it resets the label's uppercase itself —
    // Inherited properties cross the shadow boundary and `case 1` rendered as `CASE 1`.
    expect(labels[0]!.querySelector(".statement-case-key")).toBeTruthy();
    expect(labels[1]!.textContent!.trim()).toBe("Default");
  });

  test("the dispatch options row is one wrapping container, not a bare flex attribute", () => {
    const { container } = mount([{ dispatchEvent: "x" }]);
    const options = container.querySelector(".statement-dispatch-options")!;
    expect(options.querySelector(".statement-dispatch-bubbles")).toBeTruthy();
    expect(options.querySelector(".statement-dispatch-composed")).toBeTruthy();
  });

  test("every class the editor emits is one a stylesheet defines", async () => {
    // The ratchet, at the level that matters to this panel: check-styles.ts fails on a new orphan
    // Anywhere and reports a count; this fails on one introduced HERE, and names it.
    expect(await unstyledClassesOf("src/panels/statement-editor.ts")).toEqual([]);
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

// ─── Drag-reorder (registerStatementsDnD) ────────────────────────────────────

describe("drag reorder", () => {
  const raf = () =>
    new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });

  /** Mount and wait for the rAF-deferred DnD registration to land. */
  async function mountDnD(statements: JxStatement[]) {
    const mounted = mount(statements);
    await raf();
    await flush();
    return mounted;
  }

  const dragFor = (el: Element) => draggables.find((d) => d.element === el)!;
  const dropFor = (el: Element) => dropTargets.find((d) => d.element === el)!;

  /** Real tree-item hitbox data for a drag hovering the row at `clientY` (row rect 0–32px). */
  function dropDataFor(row: HTMLElement, clientY: number): AnyRec {
    stubRect(row, { height: 32, top: 0 });
    return dropFor(row).getData({ element: row, input: { clientX: 10, clientY } });
  }

  const three: JxStatement[] = [
    { dispatchEvent: "a" },
    { dispatchEvent: "b" },
    { dispatchEvent: "c" },
  ];

  test("registers per-row draggables carrying index/lane data, handle, and a hidden preview", async () => {
    const { container } = await mountDnD(three);
    const rows = cards(container);
    expect(dragFor(rows[1]!).getInitialData()).toEqual({ index: 1, lane: "[]", type: "statement" });
    expect(dragFor(rows[0]!).dragHandle).toBe(rows[0]!.querySelector(".statement-drag-handle")!);

    // Generating a preview routes the native setter through disableNativeDragPreview.
    const before = previewsDisabled.length;
    const setter = () => {};
    dragFor(rows[0]!).onGenerateDragPreview({ nativeSetDragImage: setter });
    expect(previewsDisabled.length).toBe(before + 1);
    expect(previewsDisabled.at(-1)).toEqual({ nativeSetDragImage: setter });
  });

  test("dragging toggles the row's dragging class", async () => {
    const { container } = await mountDnD(three);
    const row = cards(container)[0]!;
    dragFor(row).onDragStart();
    expect(row.classList.contains("dragging")).toBe(true);
    dragFor(row).onDrop();
    expect(row.classList.contains("dragging")).toBe(false);
  });

  test("canDrop accepts only statements from the same lane", async () => {
    const { container } = await mountDnD([
      { if: { $ref: "#/state/count" }, then: [{ dispatchEvent: "x" }] },
    ]);
    const rows = cards(container);
    expect(rows[1]!.dataset.stmtLane).toBe('[0,"then"]');
    const topDrop = dropFor(rows[0]!);
    expect(topDrop.canDrop({ source: { data: { lane: "[]", type: "statement" } } })).toBe(true);
    expect(topDrop.canDrop({ source: { data: { lane: '[0,"then"]', type: "statement" } } })).toBe(
      false,
    );
    expect(topDrop.canDrop({ source: { data: { lane: "[]", type: "block" } } })).toBe(false);
  });

  test("getData attaches the tree-item hitbox instruction with make-child blocked", async () => {
    const { container } = await mountDnD(three);
    const row = cards(container)[1]!;
    const above = dropDataFor(row, 4);
    expect(above.index).toBe(1);
    expect(extractInstruction(above)?.type).toBe("reorder-above");
    expect(extractInstruction(dropDataFor(row, 30))?.type).toBe("reorder-below");
    // The middle zone would be make-child — blocked for statement rows.
    expect(extractInstruction(dropDataFor(row, 16))?.type).toBe("instruction-blocked");
  });

  test("onDrag shows the reorder edge; onDragLeave and onDrop clear it", async () => {
    const { container, changes } = await mountDnD(three);
    const row = cards(container)[1]!;
    const drop = dropFor(row);
    drop.onDrag({ self: { data: dropDataFor(row, 4) } });
    expect(row.classList.contains("drop-above")).toBe(true);
    expect(row.classList.contains("drop-below")).toBe(false);
    drop.onDrag({ self: { data: dropDataFor(row, 30) } });
    expect(row.classList.contains("drop-above")).toBe(false);
    expect(row.classList.contains("drop-below")).toBe(true);
    drop.onDragLeave();
    expect(row.classList.contains("drop-below")).toBe(false);
    // A drop without an instruction still clears the edge markers, then bails.
    drop.onDrag({ self: { data: dropDataFor(row, 4) } });
    drop.onDrop({ self: { data: {} }, source: { data: { index: 0, lane: "[]" } } });
    expect(row.classList.contains("drop-above")).toBe(false);
    expect(changes).toHaveLength(0);
  });

  test("dropping above/below reorders the top-level lane immutably", async () => {
    const { container, changes } = await mountDnD(three);
    const rows = cards(container);
    // C dropped above a → [c, a, b]
    dropFor(rows[0]!).onDrop({
      self: { data: dropDataFor(rows[0]!, 4) },
      source: { data: { index: 2, lane: "[]", type: "statement" } },
    });
    expect(changes[0]).toEqual([
      { dispatchEvent: "c" },
      { dispatchEvent: "a" },
      { dispatchEvent: "b" },
    ]);
    // A dropped below c → [b, c, a]
    dropFor(rows[2]!).onDrop({
      self: { data: dropDataFor(rows[2]!, 30) },
      source: { data: { index: 0, lane: "[]", type: "statement" } },
    });
    expect(changes[1]).toEqual([
      { dispatchEvent: "b" },
      { dispatchEvent: "c" },
      { dispatchEvent: "a" },
    ]);
    // The mounted list itself was never mutated.
    expect(three.map((s) => (s as { dispatchEvent: string }).dispatchEvent)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("no-op drops: blocked instruction, same row, and a same-position reorder", async () => {
    const { container, changes } = await mountDnD(three);
    const rows = cards(container);
    // Blocked (middle-zone) instruction
    dropFor(rows[1]!).onDrop({
      self: { data: dropDataFor(rows[1]!, 16) },
      source: { data: { index: 0, lane: "[]", type: "statement" } },
    });
    // Dropping a row onto itself
    dropFor(rows[1]!).onDrop({
      self: { data: dropDataFor(rows[1]!, 4) },
      source: { data: { index: 1, lane: "[]", type: "statement" } },
    });
    // A reorder that lands where it started: b below a
    dropFor(rows[0]!).onDrop({
      self: { data: dropDataFor(rows[0]!, 30) },
      source: { data: { index: 1, lane: "[]", type: "statement" } },
    });
    expect(changes).toHaveLength(0);
  });

  test("reorder inside a branch lane writes through the statement tree", async () => {
    const stmt: JxStatement = {
      if: { $ref: "#/state/count" },
      then: [{ dispatchEvent: "x" }, { dispatchEvent: "y" }],
    };
    const { container, changes } = await mountDnD([stmt]);
    const nested = cards(container).filter((c) => c.dataset.stmtLane === '[0,"then"]');
    expect(nested).toHaveLength(2);
    dropFor(nested[0]!).onDrop({
      self: { data: dropDataFor(nested[0]!, 4) },
      source: { data: { index: 1, lane: '[0,"then"]', type: "statement" } },
    });
    expect(changes[0]).toEqual([
      { if: { $ref: "#/state/count" }, then: [{ dispatchEvent: "y" }, { dispatchEvent: "x" }] },
    ]);
    expect((stmt as { then: JxStatement[] }).then).toEqual([
      { dispatchEvent: "x" },
      { dispatchEvent: "y" },
    ]);
  });
});

// ─── The editor has two hosts, so it may not name one ─────────────────────────

describe("the region id names the HOST, not the control", () => {
  /*
   * `renderStatementEditor` hard-stamped `data-jx-region="navigator/statements"` on itself, and it
   * has two hosts that can be open at the same time: the Navigator's State panel
   * (`panels/signals-panel.ts`) and the INSPECTOR's Events tab (`panels/events-panel.ts`).
   * `resolveRegion` takes the LAST match in document order and `#right-panel` follows
   * `#left-panel`, so the id resolved to the Inspector's editor while saying Navigator — and the
   * `statement-editor` shot cropped a control in the wrong dock.
   *
   * The verdict is the one `ui/regions.ts`'s `DERIVED_RESOLVERS` already records for the media
   * picker's Browse button: an id claiming a surface the element is not in is not a pane-scoping
   * problem, it is a wrong id.
   */
  function bothDocks() {
    document.body.innerHTML = `<div id="app"><div id="left-panel"></div><div id="right-panel"></div></div>`;
    const stmts: JxStatement[] = [{ operator: "=", target: { $ref: "#/state/count" }, value: 1 }];
    render(
      renderStatementEditor(stmts, () => {}, {
        ...DEFAULT_OPTS,
        region: NAVIGATOR_STATEMENTS_REGION,
      } as never),
      document.querySelector("#left-panel")!,
    );
    render(
      renderStatementEditor(stmts, () => {}, {
        ...DEFAULT_OPTS,
        region: inspectorStatementsRegion("onClick"),
      } as never),
      document.querySelector("#right-panel")!,
    );
  }

  test("with both editors open, each id resolves to exactly one, in its own dock", () => {
    bothDocks();

    const navigator = resolveAllRegions(NAVIGATOR_STATEMENTS_REGION);
    const inspector = resolveAllRegions(inspectorStatementsRegion("onClick"));
    console.log(
      `[statement-editor] both docks open: navigator/statements → ${navigator.length} element(s), ` +
        `inspector/statements:onClick → ${inspector.length}`,
    );
    expect(navigator).toHaveLength(1);
    expect(inspector).toHaveLength(1);
    // The shot's id crops the NAVIGATOR's editor — the one the docs page is about.
    expect(resolveRegion(NAVIGATOR_STATEMENTS_REGION)!.closest("#left-panel")).not.toBeNull();
    expect(
      resolveRegion(inspectorStatementsRegion("onClick"))!.closest("#right-panel"),
    ).not.toBeNull();
  });

  /*
   * The Inspector's Events tab draws ONE of these per structured handler on the selected node, so a
   * constant `inspector/statements` was unique only while a node had a single handler. Two handlers
   * made two elements answer to it and `resolveRegion` took the second — the same defect the
   * Navigator/Inspector split closed, one level further in.
   */
  test("two handlers on one node are two ids, each resolving to its own editor", () => {
    document.body.innerHTML = `<div id="app"><div id="right-panel"></div></div>`;
    const host = document.querySelector("#right-panel")!;
    const stmts: JxStatement[] = [{ operator: "=", target: { $ref: "#/state/count" }, value: 1 }];
    for (const evKey of ["onClick", "onInput"]) {
      const slot = document.createElement("div");
      host.append(slot);
      render(
        renderStatementEditor(stmts, () => {}, {
          ...DEFAULT_OPTS,
          region: inspectorStatementsRegion(evKey),
        } as never),
        slot,
      );
    }
    const clickEditors = resolveAllRegions(inspectorStatementsRegion("onClick"));
    const inputEditors = resolveAllRegions(inspectorStatementsRegion("onInput"));
    console.log(
      `[statement-editor] two handlers: inspector/statements:onClick → ${clickEditors.length}, ` +
        `inspector/statements:onInput → ${inputEditors.length}`,
    );
    expect(clickEditors).toHaveLength(1);
    expect(inputEditors).toHaveLength(1);
    expect(clickEditors[0]).not.toBe(inputEditors[0]);
  });

  test("a third host cannot appear without naming itself", () => {
    // `region` is required on `StatementEditorOpts`, so the stamp is whatever the host said and
    // Nothing else. There is no default to fall back to being wrong about.
    const container = document.createElement("div");
    render(
      renderStatementEditor([], () => {}, { ...DEFAULT_OPTS, region: "dock.bottom/statements" }),
      container,
    );
    expect((container.querySelector(".statement-editor") as HTMLElement).dataset.jxRegion).toBe(
      "dock.bottom/statements",
    );
  });
});
