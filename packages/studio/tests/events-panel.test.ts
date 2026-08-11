/**
 * Tests for src/panels/events-panel.ts — the **Logic** tab.
 *
 * Events were always here. Repeating list, Condition, Observed Attributes, CSS Properties and CSS
 * Parts arrived from the Content tab in P5 (§6.5): wiring a `$switch` and wiring a click handler
 * are the same task, and they were two tabs apart.
 */
import { pointer, renderInto, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { renderLogicPanelTemplate, EVENT_NAMES } from "../src/panels/events-panel";
import { resetSlotModeMemory } from "../src/ui/dynamic-slot";
import { getNodeAtPath } from "../src/store";
import { activeTab } from "../src/workspace/workspace";

import type { JxMutableNode } from "@jxsuite/schema/types";

const notCustom = { isCustomElementDoc: () => false };
const isCustom = { isCustomElementDoc: () => true };

function makeDoc(): JxMutableNode {
  return {
    children: [
      {
        onchange: { $ref: "#/state/handleClick" },
        onclick: { $prototype: "Function", body: "doIt()", parameters: [] },
        onfocus: "not-a-binding",
        oninput: { $expression: { operator: "=", target: null } },
        tagName: "button",
        textContent: "B",
      },
      { tagName: "p", textContent: "plain" },
    ],
    state: {
      handleClick: {
        $prototype: "Function",
        body: "console.log(1)",
        emits: [
          { description: "Save happened", name: "save", type: { text: "CustomEvent" } },
          { name: "" },
        ],
        parameters: [],
      },
      legacyHandler: { $handler: "x" },
    },
    tagName: "div",
  } as unknown as JxMutableNode;
}

function selectedNode() {
  const tab = activeTab.value!;
  return getNodeAtPath(tab.doc.document, tab.session.selection.at(-1)!) as Record<string, unknown>;
}

function picker(container: HTMLElement, cls: string, index = 0) {
  return container.querySelectorAll(`sp-picker.${cls}`)[index] as HTMLElement & { value: string };
}

/** The event NAME field, which is a free-form combobox rather than a ten-item picker. */
function nameField(container: HTMLElement, index = 0) {
  return container.querySelectorAll("jx-value-selector.event-name")[index] as HTMLElement & {
    value: string;
  };
}

function changeValue(el: HTMLElement & { value: string }, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Logic tab — empty states", () => {
  test("no selection shows prompt", async () => {
    resetWorkspaceWithTab(makeDoc());
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    expect(container.textContent).toContain("Click anything on the canvas to wire it up.");
  });

  test("selection pointing at missing node shows not-found", async () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = [["children", 9]];
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    expect(container.textContent).toContain("no longer on the page");
  });
});

describe("Logic tab — rendering bindings", () => {
  beforeEach(() => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = [["children", 0]];
  });

  test("renders one binding row per on* key with a valid binding", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const bindings = container.querySelectorAll(".event-binding");
    // Onfocus is a bare string, not a binding — excluded
    expect(bindings.length).toBe(3);
    expect(container.textContent).toContain("Event Bindings");
  });

  test("inline function binding shows body textfield", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const body = container.querySelector(".event-body-row sp-textfield") as HTMLElement & {
      value: string;
    };
    expect(body).toBeTruthy();
    expect(body.value).toBe("doIt()");
  });

  test("expression binding renders expression editor", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    expect(container.querySelector(".expression-editor")).toBeTruthy();
  });

  test("ref binding renders handler picker with current ref and function defs", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const handler = picker(container, "event-handler");
    expect(handler).toBeTruthy();
    expect(handler.value).toBe("#/state/handleClick");
    const items = [...handler.querySelectorAll("sp-menu-item")].map((i) => i.textContent);
    expect(items).toContain("— none —");
    expect(items).toContain("handleClick");
    expect(items).toContain("legacyHandler");
  });

  test("declared events hidden for non-custom-element docs", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    expect(container.querySelector(".declared-event-row")).toBeNull();
  });

  test("declared events listed for custom element docs", async () => {
    const container = await renderInto(renderLogicPanelTemplate(isCustom));
    const rows = container.querySelectorAll(".declared-event-row");
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("save");
    expect(rows[0]?.textContent).toContain("← handleClick");
    expect(rows[0]?.textContent).toContain("CustomEvent");
    // Second emit has no name and no type
    expect(rows[1]?.textContent).toContain("(unnamed)");
    expect(rows[1]?.querySelector(".event-type")).toBeNull();
  });
});

describe("Logic tab — editing bindings", () => {
  beforeEach(() => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = [["children", 0]];
  });

  // Binding rows render in node key order: onchange ($ref), onclick (inline), oninput (expression)

  test("renaming an event moves the binding to the new key", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(nameField(container), "onkeydown");
    const node = selectedNode();
    expect(node.onchange).toBeUndefined();
    expect(node.onkeydown).toEqual({ $ref: "#/state/handleClick" });
  });

  test("renaming to the same key is a no-op", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(nameField(container), "onchange");
    const node = selectedNode();
    expect(node.onchange).toEqual({ $ref: "#/state/handleClick" });
  });

  test("an event NOT in the suggestion list can be typed — the whole point of the field", async () => {
    // Ten names in a closed `sp-picker` meant `ondragover`, `onpointerdown`, `onwheel` and every
    // Custom event a component emits were unbindable from the Inspector. Plan §6.5 asks for "a
    // Free-form combobox instead of a hard-coded list of ten", and `ui/value-selector.ts` was
    // Written for this field and never wired to it.
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(nameField(container), "onpointerdown");
    const node = selectedNode();
    expect(node.onchange).toBeUndefined();
    expect(node.onpointerdown).toEqual({ $ref: "#/state/handleClick" });
  });

  test("…and a name that is not an event handler is refused", async () => {
    // Free-form is not unchecked: the field no longer has a list constraining it, so it states the
    // Shape itself rather than writing `class` or `Hello there` onto the element as a binding.
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    for (const bad of ["class", "Hello there", "on", "click"]) {
      changeValue(nameField(container), bad);
      expect(selectedNode().onchange).toEqual({ $ref: "#/state/handleClick" });
    }
  });

  test("switching mode to Formula replaces value with expression def", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(picker(container, "event-mode", 0), "expression");
    expect(selectedNode().onchange).toEqual({
      $expression: { operator: "=", target: null },
    });
  });

  test("switching mode to Inline function replaces value with empty function def", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(picker(container, "event-mode", 2), "function");
    expect(selectedNode().oninput).toEqual({
      $prototype: "Function",
      body: "",
      parameters: [],
    });
  });

  test("switching mode to From data… uses first function def", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(picker(container, "event-mode", 1), "ref");
    expect(selectedNode().onclick).toEqual({ $ref: "#/state/handleClick" });
  });

  test("the mode picker speaks the one Value Source vocabulary", async () => {
    /* It used to read Inline code / Expression / Existing function — a private dialect for the
       ladder every other row in the inspector names Fixed value / From data… / Formula. */
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const items = [...picker(container, "event-mode").querySelectorAll("sp-menu-item")];
    expect(items.map((i) => i.getAttribute("value"))).toEqual(["ref", "expression", "function"]);
    expect(items.map((i) => i.textContent!.trim())).toEqual([
      "From data…",
      "Formula",
      "Inline function",
    ]);
  });

  test("switching a handler away and back restores the body it left", async () => {
    let container = await renderInto(renderLogicPanelTemplate(notCustom));
    // Onclick holds an inline function; leave it for Formula, then come back.
    changeValue(picker(container, "event-mode", 1), "expression");
    expect(selectedNode().onclick).toEqual({ $expression: { operator: "=", target: null } });
    container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(picker(container, "event-mode", 1), "function");
    expect((selectedNode().onclick as { body: unknown }).body).toBe("doIt()");
  });

  test("switching mode to From data… with no function defs uses empty ref", async () => {
    const tab = resetWorkspaceWithTab({
      children: [{ onclick: { $prototype: "Function", body: "x()" }, tagName: "button" }],
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(picker(container, "event-mode"), "ref");
    expect(selectedNode().onclick).toEqual({ $ref: "" });
  });

  test("delete button removes the binding", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const del = container.querySelector(".event-row sp-action-button") as HTMLElement;
    del.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selectedNode().onchange).toBeUndefined();
  });

  test("typing in the inline body updates the function def", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const body = container.querySelector(".event-body-row sp-textfield") as HTMLElement & {
      value: string;
    };
    body.value = "save();";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    expect(selectedNode().onclick).toEqual({
      $prototype: "Function",
      body: "save();",
      parameters: [],
    });
  });

  test("open-in-editor button sets editingFunction ui state", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const openBtn = container.querySelector(
      ".event-body-row sp-action-button[title='Open in editor']",
    ) as HTMLElement;
    openBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const tab = activeTab.value!;
    expect(tab.session.ui.editingFunction).toEqual({
      eventKey: "onclick",
      path: ["children", 0],
      type: "event",
    });
  });

  test("open-in-formula-workspace button sets editingFormula ui state", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const openBtn = container.querySelector(
      ".event-body-row sp-action-button[title='Open in formula workspace']",
    ) as HTMLElement;
    openBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const tab = activeTab.value!;
    expect(tab.session.ui.editingFormula).toEqual({
      eventKey: "oninput",
      path: ["children", 0],
      type: "event",
    });
  });

  test("handler picker change sets a new ref", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(picker(container, "event-handler"), "#/state/legacyHandler");
    expect(selectedNode().onchange).toEqual({ $ref: "#/state/legacyHandler" });
  });

  test("handler picker set to none removes the binding", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    changeValue(picker(container, "event-handler"), "__none__");
    expect(selectedNode().onchange).toBeUndefined();
  });

  test("expression editor onChange writes back through $expression", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const opPicker = container.querySelector(".expression-editor sp-picker") as HTMLElement & {
      value: string;
    };
    expect(opPicker).toBeTruthy();
    changeValue(opPicker, "push");
    const updated = selectedNode().oninput as { $expression?: { operator?: string } };
    expect(updated.$expression?.operator).toBe("push");
  });
});

describe("Logic tab — inline body modes (spec §20)", () => {
  beforeEach(() => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = [["children", 0]];
  });

  test("string body renders the Code mode: toggle present, textarea shown", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const toggle = container.querySelector(".body-mode-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.querySelector(".body-mode-code")?.hasAttribute("selected")).toBe(true);
    expect(toggle?.querySelector(".body-mode-statements")?.hasAttribute("selected")).toBe(false);
    expect(container.querySelector(".event-body-row sp-textfield")).not.toBeNull();
    expect(container.querySelector(".statement-editor")).toBeNull();
  });

  test("switching to Statements replaces the body with an empty array", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const btn = container.querySelector(".body-mode-toggle .body-mode-statements") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selectedNode().onclick).toEqual({
      $prototype: "Function",
      body: [],
      parameters: [],
    });
  });

  test("array body renders the statement editor and Statements is selected", async () => {
    const tab = resetWorkspaceWithTab({
      children: [
        {
          onclick: { $prototype: "Function", body: [{ dispatchEvent: "ping" }], parameters: [] },
          tagName: "button",
        },
      ],
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    expect(
      container.querySelector(".body-mode-toggle .body-mode-statements")?.hasAttribute("selected"),
    ).toBe(true);
    expect(container.querySelector(".statement-editor")).not.toBeNull();
    expect(container.querySelector(".event-body-row sp-textfield")).toBeNull();
  });

  test("switching back to Code replaces the body with an empty string", async () => {
    const tab = resetWorkspaceWithTab({
      children: [
        { onclick: { $prototype: "Function", body: [], parameters: [] }, tagName: "button" },
      ],
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const btn = container.querySelector(".body-mode-toggle .body-mode-code") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selectedNode().onclick).toEqual({
      $prototype: "Function",
      body: "",
      parameters: [],
    });
  });

  test("re-clicking the active mode preserves the existing body", async () => {
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const btn = container.querySelector(".body-mode-toggle .body-mode-code") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect((selectedNode().onclick as { body: string }).body).toBe("doIt()");
  });

  test("statement editor edits write the inline binding through", async () => {
    const tab = resetWorkspaceWithTab({
      children: [
        { onclick: { $prototype: "Function", body: [], parameters: [] }, tagName: "button" },
      ],
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const add = container.querySelector("sp-picker.statement-add") as HTMLElement & {
      value: string;
    };
    add.value = "dispatch";
    add.dispatchEvent(new Event("change", { bubbles: true }));
    expect(selectedNode().onclick).toEqual({
      $prototype: "Function",
      body: [{ dispatchEvent: "" }],
      parameters: [],
    });
  });

  test("dispatch statements offer the inline def's declared emits names", async () => {
    const tab = resetWorkspaceWithTab({
      children: [
        {
          onclick: {
            $prototype: "Function",
            body: [{ dispatchEvent: "" }],
            emits: [{ name: "saved" }],
            parameters: [],
          },
          tagName: "button",
        },
      ],
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const combo = container.querySelector(".statement-dispatch-name");
    expect(combo?.tagName.toLowerCase()).toBe("sp-combobox");
    const names = [...combo!.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"));
    expect(names).toEqual(["saved"]);
  });
});

describe("Logic tab — add event", () => {
  test("add event picks the first unused event name and refs the first function", async () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = [["children", 0]];
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const addBtn = [...container.querySelectorAll("sp-action-button")].find((b) =>
      b.textContent?.includes("Add Event"),
    ) as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const node = selectedNode();
    // Onclick/oninput/onchange taken; onfocus is a plain string (truthy) — onsubmit is next free
    expect(node.onsubmit).toEqual({ $ref: "#/state/handleClick" });
  });

  test("add event falls back to onclick + inline function with no defs", async () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "x" }],
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    const container = await renderInto(renderLogicPanelTemplate(notCustom));
    const addBtn = [...container.querySelectorAll("sp-action-button")].find((b) =>
      b.textContent?.includes("Add Event"),
    ) as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selectedNode().onclick).toEqual({
      $prototype: "Function",
      body: "",
      parameters: [],
    });
  });

  test("EVENT_NAMES exposes the standard handler list", () => {
    expect(EVENT_NAMES).toContain("onclick");
    expect(EVENT_NAMES).toContain("onmouseleave");
  });
});

// ─── Sections that arrived from Content (§6.5) ────────────────────────────────

function logic(helpers = notCustom) {
  return renderInto(renderLogicPanelTemplate(helpers));
}

function section(root: Element, label: string): HTMLElement | null {
  return root.querySelector(`sp-accordion-item[label="${label}"]`);
}

function rowByLabel(root: Element, label: string): HTMLElement | undefined {
  return [...root.querySelectorAll(".style-row")].find(
    (r) => r.querySelector("sp-field-label")?.textContent?.trim() === label,
  ) as HTMLElement | undefined;
}

function kvAdd(root: Element, text: string): HTMLElement | undefined {
  return [...root.querySelectorAll(".kv-add")].find((el) => el.textContent?.includes(text)) as
    | HTMLElement
    | undefined;
}

/** Pick a rung on a row's Value Source control (`ui/dynamic-slot.ts`). */
function chooseValueSource(row: Element, mode: "literal" | "ref" | "template") {
  pointer(row.querySelector(`sp-menu-item[data-mode="${mode}"]`)!, "click");
}

function docNow(): Record<string, any> {
  return activeTab.value!.doc.document as unknown as Record<string, any>;
}

function repeaterDoc(extra: Record<string, unknown> = {}) {
  return {
    children: {
      $prototype: "Array",
      items: { $ref: "#/state/posts" },
      map: { tagName: "li" },
      ...extra,
    },
    state: { posts: { default: ["a"] } },
    tagName: "ul",
  } as unknown as JxMutableNode;
}

describe("Logic tab — repeating list", () => {
  beforeEach(() => {
    resetSlotModeMemory();
  });

  test("a map node shows the Repeating list section and no Events section", async () => {
    const tab = resetWorkspaceWithTab(repeaterDoc());
    tab.session.selection = [["children", 0]];
    const c = await logic();
    expect(section(c, "Repeating list")).not.toBeNull();
    // A repeater has no `on*` position the renderer would ever mount.
    expect(section(c, "Events")).toBeNull();
    expect(rowByLabel(c, "Items")).toBeDefined();
  });

  test("Items is a real field row — set-dot vocabulary, data-prop, and the value source chip", async () => {
    const tab = resetWorkspaceWithTab(repeaterDoc());
    tab.session.selection = [["children", 0]];
    const c = await logic();
    const row = c.querySelector('[data-prop="items"]')!;
    expect(row.classList.contains("style-row")).toBe(true);
    expect(row.querySelector(".dynamic-slot-mode")).not.toBeNull();
  });

  test("Filter and Sort are always rows — no + Add link seeding a binding to nothing", async () => {
    const tab = resetWorkspaceWithTab(repeaterDoc());
    tab.session.selection = [["children", 0]];
    const c = await logic();
    expect(rowByLabel(c, "Filter")).toBeDefined();
    expect(rowByLabel(c, "Sort")).toBeDefined();
    expect(kvAdd(c, "+ Add filter")).toBeUndefined();
    expect(kvAdd(c, "+ Add sort")).toBeUndefined();
    // Unset, so neither carries a clear affordance yet.
    expect(c.querySelector('[data-prop="filter"] .set-dot')).toBeNull();
  });

  test("typing a filter sets it; emptying it removes the key", async () => {
    const tab = resetWorkspaceWithTab(repeaterDoc());
    tab.session.selection = [["children", 0]];
    let c = await logic();
    const field = c.querySelector('[data-prop="filter"] sp-textfield') as HTMLInputElement;
    field.value = "a > 1";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docNow().children[0].filter).toBe("a > 1");

    c = await logic();
    const again = c.querySelector('[data-prop="filter"] sp-textfield') as HTMLInputElement;
    again.value = "";
    again.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docNow().children[0].filter).toBeUndefined();
  });

  test("the Filter row's set-dot removes the key outright", async () => {
    const tab = resetWorkspaceWithTab(repeaterDoc({ filter: "a > 1" }));
    tab.session.selection = [["children", 0]];
    const c = await logic();
    pointer(c.querySelector('[data-prop="filter"] .set-dot')!, "click");
    expect(docNow().children[0].filter).toBeUndefined();
  });

  test("Items has no clear affordance: a repeater without a source is not a state to reach", async () => {
    const tab = resetWorkspaceWithTab(repeaterDoc());
    tab.session.selection = [["children", 0]];
    const c = await logic();
    expect(c.querySelector('[data-prop="items"] .set-dot')).toBeNull();
  });

  test("Edit template moves the selection into the map node", async () => {
    const tab = resetWorkspaceWithTab(repeaterDoc());
    tab.session.selection = [["children", 0]];
    const c = await logic();
    pointer(c.querySelector(".logic-edit-template")!, "click");
    expect(tab.session.selection).toEqual([["children", 0, "map"]]);
  });

  test("dropping Items to a fixed value restores the signal's declared default", async () => {
    const tab = resetWorkspaceWithTab(repeaterDoc());
    tab.session.selection = [["children", 0]];
    const c = await logic();
    chooseValueSource(c.querySelector('[data-prop="items"]')!, "literal");
    expect(docNow().children[0].items).toBe('["a"]');
  });

  test("handler and Function state entries are excluded from the signal options", async () => {
    const tab = resetWorkspaceWithTab({
      children: { $prototype: "Array", items: { $ref: "#/state/posts" }, map: { tagName: "li" } },
      state: {
        fn: { $prototype: "Function", arguments: [], body: "" },
        onClick: { $handler: "x" },
        posts: { default: [] },
      },
      tagName: "ul",
    } as unknown as JxMutableNode);
    tab.session.selection = [["children", 0]];
    const c = await logic();
    const items = [
      ...c.querySelector('[data-prop="items"] sp-picker')!.querySelectorAll("sp-menu-item"),
    ].map((m) => m.textContent?.trim());
    expect(items).toEqual(["posts"]);
  });
});

function switchDoc() {
  return {
    children: {
      $prototype: "Array",
      items: [],
      map: {
        $switch: "${item.type}",
        cases: { alpha: { tagName: "div" }, beta: { tagName: "span" } },
        tagName: "li",
      },
    },
    tagName: "ul",
  } as unknown as JxMutableNode;
}

describe("Logic tab — condition", () => {
  test("renders the expression row and one field row per case", async () => {
    const tab = resetWorkspaceWithTab(switchDoc());
    tab.session.selection = [["children", 0, "map"]];
    const c = await logic();
    const sw = section(c, "Condition")!;
    expect(sw).not.toBeNull();
    expect(rowByLabel(sw, "Expression")).toBeDefined();
    const names = [...sw.querySelectorAll("sp-textfield.logic-case-name")].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("a case row carries the row vocabulary — data-prop and a chip that removes it", async () => {
    const tab = resetWorkspaceWithTab(switchDoc());
    tab.session.selection = [["children", 0, "map"]];
    const c = await logic();
    const row = c.querySelector('[data-prop="case:alpha"]')!;
    expect(row.classList.contains("style-row")).toBe(true);
    const chip = row.querySelector(".provenance-chip")!;
    expect(chip.getAttribute("title")).toBe('Remove case "alpha"');
    pointer(chip, "click");
    expect(Object.keys(docNow().children[0].map.cases)).toEqual(["beta"]);
  });

  test("the edit arrow navigates the selection into the case", async () => {
    const tab = resetWorkspaceWithTab(switchDoc());
    tab.session.selection = [["children", 0, "map"]];
    const c = await logic();
    pointer(c.querySelector('[title="Edit case"]')!, "click");
    expect(tab.session.selection).toEqual([["children", 0, "map", "cases", "alpha"]]);
  });

  test("+ Add case appends a numbered one", async () => {
    const tab = resetWorkspaceWithTab(switchDoc());
    tab.session.selection = [["children", 0, "map"]];
    const c = await logic();
    pointer(kvAdd(c, "+ Add case")!, "click");
    expect(Object.keys(docNow().children[0].map.cases)).toEqual(["alpha", "beta", "case3"]);
  });

  test("renaming a case commits after its 500ms debounce", async () => {
    const tab = resetWorkspaceWithTab(switchDoc());
    tab.session.selection = [["children", 0, "map"]];
    const c = await logic();
    const input = c.querySelector("sp-textfield.logic-case-name") as HTMLInputElement;
    input.value = "gamma";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => {
      setTimeout(resolve, 560);
    });
    expect(Object.keys(docNow().children[0].map.cases)).toEqual(["beta", "gamma"]);
  });

  test("inside a map template the expression offers the $map signals", async () => {
    const tab = resetWorkspaceWithTab(switchDoc());
    tab.session.selection = [["children", 0, "map"]];
    let c = await logic();
    chooseValueSource(c.querySelector('[data-prop="$switch"]')!, "ref");
    expect(docNow().children[0].map.$switch).toEqual({ $ref: "$map/item" });

    c = await logic();
    const refPicker = c.querySelector('[data-prop="$switch"] sp-picker')!;
    const opts = [...refPicker.querySelectorAll("sp-menu-item")].map((m) =>
      m.getAttribute("value"),
    );
    expect(opts).toContain("$map/item");
    expect(opts).toContain("$map/index");
  });

  test("the Expression row offers no Fixed value rung — a $switch is inherently dynamic", async () => {
    const tab = resetWorkspaceWithTab(switchDoc());
    tab.session.selection = [["children", 0, "map"]];
    const c = await logic();
    const modes = [...c.querySelectorAll('[data-prop="$switch"] sp-menu-item[data-mode]')].map(
      (m) => (m as HTMLElement).dataset.mode,
    );
    expect(modes).not.toContain("literal");
  });
});

function widgetDoc(overrides: Record<string, unknown> = {}) {
  return {
    attributes: { part: "root" },
    children: [{ attributes: { part: "icon" }, tagName: "span" }],
    state: {
      label: { attribute: "label", default: "x", reflects: true, type: "string" },
      plain: { default: 1 },
    },
    style: { "--accent": "red", color: "blue" },
    tagName: "my-widget",
    ...overrides,
  } as unknown as JxMutableNode;
}

describe("Logic tab — the custom element's outward contract", () => {
  test("observed attributes list only state entries with an attribute, as one static row each", async () => {
    const tab = resetWorkspaceWithTab(widgetDoc());
    tab.session.selection = [[]];
    const c = await logic(isCustom);
    const observed = section(c, "Observed Attributes")!;
    expect(observed).not.toBeNull();
    const row = observed.querySelector(".kv-static-row")!;
    expect(row.querySelector(".kv-static-name")!.textContent).toBe("label");
    expect(row.querySelector(".kv-static-detail")!.textContent).toBe("→ label");
    expect(row.querySelector(".kv-static-value")!.textContent).toBe("string");
    expect(row.querySelector(".kv-static-tag")!.textContent).toBe("reflects");
    expect(observed.textContent).not.toContain("plain");
  });

  test("no attribute entries → the empty-state hint", async () => {
    const tab = resetWorkspaceWithTab(widgetDoc({ state: { plain: { default: 1 } } }));
    tab.session.selection = [[]];
    const c = await logic(isCustom);
    expect(section(c, "Observed Attributes")!.textContent).toContain(
      "Attributes let a page set this component from markup",
    );
  });

  test("CSS Properties lists only custom properties", async () => {
    const tab = resetWorkspaceWithTab(widgetDoc());
    tab.session.selection = [[]];
    const c = await logic(isCustom);
    const cssProps = section(c, "CSS Properties")!;
    expect(cssProps.textContent).toContain("--accent");
    expect(cssProps.textContent).toContain("red");
    expect(cssProps.textContent).not.toContain("blue");
  });

  test("CSS Properties is omitted without custom properties", async () => {
    const tab = resetWorkspaceWithTab(widgetDoc({ style: { color: "blue" } }));
    tab.session.selection = [[]];
    const c = await logic(isCustom);
    expect(section(c, "CSS Properties")).toBeNull();
  });

  test("CSS Parts collects part attributes from the tree", async () => {
    const tab = resetWorkspaceWithTab(widgetDoc());
    tab.session.selection = [[]];
    const c = await logic(isCustom);
    const parts = section(c, "CSS Parts")!;
    expect(parts.textContent).toContain("root");
    expect(parts.textContent).toContain("icon");
    expect(parts.textContent).toContain("<span>");
  });

  test("CSS Parts is omitted when no parts exist", async () => {
    const tab = resetWorkspaceWithTab(
      widgetDoc({ attributes: {}, children: [{ tagName: "span" }] }),
    );
    tab.session.selection = [[]];
    const c = await logic(isCustom);
    expect(section(c, "CSS Parts")).toBeNull();
  });

  test("the contract sections are omitted for a non-root selection", async () => {
    const tab = resetWorkspaceWithTab(widgetDoc());
    tab.session.selection = [["children", 0]];
    const c = await logic(isCustom);
    expect(section(c, "Observed Attributes")).toBeNull();
    expect(section(c, "CSS Properties")).toBeNull();
    expect(section(c, "CSS Parts")).toBeNull();
  });

  test("a plain document's root grows no contract sections at all", async () => {
    const tab = resetWorkspaceWithTab(widgetDoc());
    tab.session.selection = [[]];
    const c = await logic(notCustom);
    expect(section(c, "Observed Attributes")).toBeNull();
    expect(section(c, "CSS Parts")).toBeNull();
  });

  test.each([
    ["Observed Attributes", "__observed"],
    ["CSS Properties", "__cssprops"],
    ["CSS Parts", "__cssparts"],
  ])("%s remembers being opened, through inspector.setSection's own record", async (label, key) => {
    const tab = resetWorkspaceWithTab(widgetDoc());
    tab.session.selection = [[]];
    let c = await logic(isCustom);
    section(c, label)!.dispatchEvent(new Event("sp-accordion-item-toggle", { bubbles: true }));
    expect(tab.session.ui.inspectorSections[key]).toBe(true);

    c = await logic(isCustom);
    expect(section(c, label)!.hasAttribute("open")).toBe(true);

    section(c, label)!.dispatchEvent(new Event("sp-accordion-item-toggle", { bubbles: true }));
    expect(tab.session.ui.inspectorSections[key]).toBe(false);
  });
});
