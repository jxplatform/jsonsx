/** Tests for src/panels/events-panel.ts — event-binding editing UI. */
import { renderInto, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { eventsSidebarTemplate, EVENT_NAMES } from "../src/panels/events-panel";
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
  return getNodeAtPath(tab.doc.document, tab.session.selection!) as Record<string, unknown>;
}

function picker(container: HTMLElement, cls: string, index = 0) {
  return container.querySelectorAll(`sp-picker.${cls}`)[index] as HTMLElement & { value: string };
}

function changeValue(el: HTMLElement & { value: string }, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("eventsSidebarTemplate — empty states", () => {
  test("no selection shows prompt", async () => {
    resetWorkspaceWithTab(makeDoc());
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    expect(container.textContent).toContain("Select an element to edit events");
  });

  test("selection pointing at missing node shows not-found", async () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = ["children", 9];
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    expect(container.textContent).toContain("Node not found");
  });
});

describe("eventsSidebarTemplate — rendering bindings", () => {
  beforeEach(() => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = ["children", 0];
  });

  test("renders one binding row per on* key with a valid binding", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    const bindings = container.querySelectorAll(".event-binding");
    // Onfocus is a bare string, not a binding — excluded
    expect(bindings.length).toBe(3);
    expect(container.textContent).toContain("Event Bindings");
  });

  test("inline function binding shows body textfield", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    const body = container.querySelector(".event-body-row sp-textfield") as HTMLElement & {
      value: string;
    };
    expect(body).toBeTruthy();
    expect(body.value).toBe("doIt()");
  });

  test("expression binding renders expression editor", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    expect(container.querySelector(".expression-editor")).toBeTruthy();
  });

  test("ref binding renders handler picker with current ref and function defs", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    const handler = picker(container, "event-handler");
    expect(handler).toBeTruthy();
    expect(handler.value).toBe("#/state/handleClick");
    const items = [...handler.querySelectorAll("sp-menu-item")].map((i) => i.textContent);
    expect(items).toContain("— none —");
    expect(items).toContain("handleClick");
    expect(items).toContain("legacyHandler");
  });

  test("declared events hidden for non-custom-element docs", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    expect(container.querySelector(".declared-event-row")).toBeNull();
  });

  test("declared events listed for custom element docs", async () => {
    const container = await renderInto(eventsSidebarTemplate(isCustom));
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

describe("eventsSidebarTemplate — editing bindings", () => {
  beforeEach(() => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = ["children", 0];
  });

  // Binding rows render in node key order: onchange ($ref), onclick (inline), oninput (expression)

  test("renaming an event moves the binding to the new key", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    changeValue(picker(container, "event-name"), "onkeydown");
    const node = selectedNode();
    expect(node.onchange).toBeUndefined();
    expect(node.onkeydown).toEqual({ $ref: "#/state/handleClick" });
  });

  test("renaming to the same key is a no-op", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    changeValue(picker(container, "event-name"), "onchange");
    const node = selectedNode();
    expect(node.onchange).toEqual({ $ref: "#/state/handleClick" });
  });

  test("switching mode to $expression replaces value with expression def", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    changeValue(picker(container, "event-mode", 0), "$expression");
    expect(selectedNode().onchange).toEqual({
      $expression: { operator: "=", target: null },
    });
  });

  test("switching mode to inline replaces value with empty function def", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    changeValue(picker(container, "event-mode", 2), "inline");
    expect(selectedNode().oninput).toEqual({
      $prototype: "Function",
      body: "",
      parameters: [],
    });
  });

  test("switching mode to ref uses first function def", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    changeValue(picker(container, "event-mode", 1), "ref");
    expect(selectedNode().onclick).toEqual({ $ref: "#/state/handleClick" });
  });

  test("switching mode to ref with no function defs uses empty ref", async () => {
    const tab = resetWorkspaceWithTab({
      children: [{ onclick: { $prototype: "Function", body: "x()" }, tagName: "button" }],
      tagName: "div",
    } as unknown as JxMutableNode);
    tab.session.selection = ["children", 0];
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    changeValue(picker(container, "event-mode"), "ref");
    expect(selectedNode().onclick).toEqual({ $ref: "" });
  });

  test("delete button removes the binding", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    const del = container.querySelector(".event-row sp-action-button") as HTMLElement;
    del.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selectedNode().onchange).toBeUndefined();
  });

  test("typing in the inline body updates the function def", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
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
    const container = await renderInto(eventsSidebarTemplate(notCustom));
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

  test("handler picker change sets a new ref", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    changeValue(picker(container, "event-handler"), "#/state/legacyHandler");
    expect(selectedNode().onchange).toEqual({ $ref: "#/state/legacyHandler" });
  });

  test("handler picker set to none removes the binding", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    changeValue(picker(container, "event-handler"), "__none__");
    expect(selectedNode().onchange).toBeUndefined();
  });

  test("expression editor onChange writes back through $expression", async () => {
    const container = await renderInto(eventsSidebarTemplate(notCustom));
    const opPicker = container.querySelector(".expression-editor sp-picker") as HTMLElement & {
      value: string;
    };
    expect(opPicker).toBeTruthy();
    changeValue(opPicker, "push");
    const updated = selectedNode().oninput as { $expression?: { operator?: string } };
    expect(updated.$expression?.operator).toBe("push");
  });
});

describe("eventsSidebarTemplate — add event", () => {
  test("add event picks the first unused event name and refs the first function", async () => {
    const tab = resetWorkspaceWithTab(makeDoc());
    tab.session.selection = ["children", 0];
    const container = await renderInto(eventsSidebarTemplate(notCustom));
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
    tab.session.selection = ["children", 0];
    const container = await renderInto(eventsSidebarTemplate(notCustom));
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
