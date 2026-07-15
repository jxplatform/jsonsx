/**
 * Tests for src/panels/properties-panel.ts — the inspector panel for element attributes, component
 * props, repeater/switch nodes, media breakpoints, and page layout selection.
 */
import {
  flush,
  installMockPlatform,
  pointer,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  invalidateLayoutPickerCache,
  invalidatePageRouteCache,
  renderPropertiesPanelTemplate,
} from "../src/panels/properties-panel";
import { componentRegistry } from "../src/files/components";
import { view } from "../src/view";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── Local helpers ────────────────────────────────────────────────────────────

const navCalls: string[] = [];
const ctx = { navigateToComponent: (p: string) => navCalls.push(p) };

async function renderPanel(): Promise<HTMLElement> {
  return await renderInto(renderPropertiesPanelTemplate(ctx));
}

function openDoc(doc: Record<string, unknown>, selection: (string | number)[] | null = []) {
  const tab = resetWorkspaceWithTab(doc as JxMutableNode);
  tab.session.selection = selection as never;
  return tab;
}

function docNow(): JxMutableNode {
  return activeTab.value!.doc.document as JxMutableNode;
}

function section(root: Element, label: string): HTMLElement | null {
  return root.querySelector(`sp-accordion-item[label="${label}"]`);
}

function fieldRowByLabel(root: Element, label: string): HTMLElement | undefined {
  return [...root.querySelectorAll(".field-row")].find(
    (r) => r.querySelector("sp-field-label")?.textContent?.trim() === label,
  ) as HTMLElement | undefined;
}

function kvAdd(root: Element, text: string): HTMLElement | undefined {
  return [...root.querySelectorAll(".kv-add")].find((el) => el.textContent?.includes(text)) as
    | HTMLElement
    | undefined;
}

function actionButtonByText(root: Element, text: string): HTMLElement | undefined {
  return [...root.querySelectorAll("sp-action-button")].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLElement | undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(() => {
  navCalls.length = 0;
  view.layoutSelection = null;
  view.showAddBreakpointForm = false;
  view.addBreakpointPreview = "";
  componentRegistry.length = 0;
  invalidateLayoutPickerCache();
  invalidatePageRouteCache();
  resetStudioState();
  installMockPlatform();
});

// ─── Empty states ─────────────────────────────────────────────────────────────

describe("empty states", () => {
  test("no tab open → 'No document loaded'", async () => {
    closeAllTabs();
    const c = await renderPanel();
    expect(c.textContent).toContain("No document loaded");
  });

  test("tab open without selection → prompt to select", async () => {
    openDoc({ children: [], tagName: "div" }, null);
    const c = await renderPanel();
    expect(c.textContent).toContain("Select an element to inspect");
  });

  test("selection pointing at a missing node → 'Node not found'", async () => {
    openDoc({ children: [{ tagName: "p" }], tagName: "div" }, ["children", 9, "children", 0]);
    const c = await renderPanel();
    expect(c.textContent).toContain("Node not found");
  });
});

// ─── Layout selection panel ───────────────────────────────────────────────────

describe("layout selection panel", () => {
  test("shows tag, class, and opens the layout via the context callback", async () => {
    openDoc({ children: [], tagName: "div" });
    const el = document.createElement("header");
    el.className = "site-header";
    view.layoutSelection = { el, layoutPath: "layouts/base.json" };

    const c = await renderPanel();
    expect(section(c, "Layout Element")).not.toBeNull();
    expect(c.textContent).toContain("header");
    expect(c.textContent).toContain("site-header");
    expect(c.textContent).toContain("part of the page layout");

    pointer(kvAdd(c, "Open Layout")!, "click");
    expect(navCalls).toEqual(["layouts/base.json"]);
  });

  test("falls back to generic labels when el/path are sparse", async () => {
    openDoc({ children: [], tagName: "div" });
    view.layoutSelection = { el: {} as HTMLElement, layoutPath: "" };

    const c = await renderPanel();
    expect(c.textContent).toContain("element");
    // No class row rendered
    expect([...c.querySelectorAll("sp-field-label")].map((l) => l.textContent)).not.toContain(
      "Class",
    );
    pointer(kvAdd(c, "Open Layout")!, "click");
    expect(navCalls).toEqual(["layout"]);
  });
});

// ─── Element section ──────────────────────────────────────────────────────────

describe("element section", () => {
  test("renders tag, id, class, text content, and hidden rows for a leaf node", async () => {
    openDoc({ children: [{ tagName: "p", textContent: "Hello" }], tagName: "div" }, [
      "children",
      0,
    ]);
    const c = await renderPanel();
    const elem = section(c, "Element")!;
    expect(elem).not.toBeNull();
    // Not auto-opened: isSectionOpen("__element") is false until the user toggles it
    expect(elem.hasAttribute("open")).toBe(false);
    expect((elem.querySelector('[data-prop="tagName"] sp-textfield') as any).value).toBe("p");
    expect(elem.querySelector('[data-prop="$id"]')).not.toBeNull();
    expect(elem.querySelector('[data-prop="className"]')).not.toBeNull();
    expect(elem.querySelector('[data-prop="textContent"]')).not.toBeNull();
    expect(elem.querySelector('[data-prop="hidden"] sp-checkbox')).not.toBeNull();
  });

  test("nodes with element children get no text content row", async () => {
    openDoc({ children: [{ children: [{ tagName: "p" }], tagName: "section" }], tagName: "div" }, [
      "children",
      0,
    ]);
    const c = await renderPanel();
    expect(c.querySelector('[data-prop="textContent"]')).toBeNull();
  });

  test("set-dots clear $id, class, text, and hidden", async () => {
    openDoc(
      {
        children: [
          {
            $id: "hero",
            className: "big",
            hidden: true,
            tagName: "p",
            textContent: "Hello",
          },
        ],
        tagName: "div",
      },
      ["children", 0],
    );
    let c = await renderPanel();
    pointer(c.querySelector('[title="Clear $id"]')!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.$id).toBeUndefined();

    c = await renderPanel();
    pointer(c.querySelector('[title="Clear class"]')!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.className).toBeUndefined();

    c = await renderPanel();
    pointer(c.querySelector('[title="Clear text"]')!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.textContent).toBeUndefined();

    c = await renderPanel();
    pointer(c.querySelector('[title="Clear hidden"]')!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.hidden).toBeUndefined();
  });

  test("editing the ID field commits on change", async () => {
    openDoc({ children: [{ tagName: "p" }], tagName: "div" }, ["children", 0]);
    const c = await renderPanel();
    const field = c.querySelector('[data-prop="$id"] sp-textfield') as HTMLInputElement;
    field.value = "headline";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$id).toBe("headline");
  });

  test("class and text content fields commit on change", async () => {
    openDoc({ children: [{ tagName: "p" }], tagName: "div" }, ["children", 0]);
    let c = await renderPanel();
    const cls = c.querySelector('[data-prop="className"] sp-textfield') as HTMLInputElement;
    cls.value = "lede";
    cls.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.className).toBe("lede");

    c = await renderPanel();
    const text = c.querySelector('[data-prop="textContent"] sp-textfield') as HTMLInputElement;
    text.value = "Body copy";
    text.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.textContent).toBe("Body copy");
  });

  test("hidden checkbox toggles the hidden property", async () => {
    openDoc({ children: [{ tagName: "p" }], tagName: "div" }, ["children", 0]);
    let c = await renderPanel();
    const box = c.querySelector('[data-prop="hidden"] sp-checkbox') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.hidden).toBe(true);

    c = await renderPanel();
    const box2 = c.querySelector('[data-prop="hidden"] sp-checkbox') as HTMLInputElement;
    box2.checked = false;
    box2.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.hidden).toBeUndefined();
  });

  test("accordion toggle event flips the section state in session ui", async () => {
    const tab = openDoc({ children: [{ tagName: "p" }], tagName: "div" }, ["children", 0]);
    let c = await renderPanel();
    section(c, "Element")!.dispatchEvent(new Event("sp-accordion-item-toggle", { bubbles: true }));
    expect(tab.session.ui.inspectorSections.__element).toBe(true);

    c = await renderPanel();
    section(c, "Element")!.dispatchEvent(new Event("sp-accordion-item-toggle", { bubbles: true }));
    expect(tab.session.ui.inspectorSections.__element).toBe(false);

    c = await renderPanel();
    expect(section(c, "Element")!.hasAttribute("open")).toBe(false);
  });
});

// ─── Repeater section ─────────────────────────────────────────────────────────

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
  };
}

describe("repeater section", () => {
  test("map node shows the Repeater section and suppresses element rows", async () => {
    openDoc(repeaterDoc(), ["children", 0]);
    const c = await renderPanel();
    expect(section(c, "Repeater")).not.toBeNull();
    expect(section(c, "Element")).toBeNull();
    expect(c.querySelector('[data-prop="tagName"]')).toBeNull();
    expect(fieldRowByLabel(c, "Items")).toBeDefined();
  });

  test("add filter / add sort links seed $ref values", async () => {
    openDoc(repeaterDoc(), ["children", 0]);
    let c = await renderPanel();
    pointer(kvAdd(c, "+ Add filter")!, "click");
    expect((docNow().children as any[])[0].filter).toEqual({ $ref: "#/state/" });

    c = await renderPanel();
    pointer(kvAdd(c, "+ Add sort")!, "click");
    expect((docNow().children as any[])[0].sort).toEqual({ $ref: "#/state/" });

    // Once present, the add links disappear and rows render instead
    c = await renderPanel();
    expect(kvAdd(c, "+ Add filter")).toBeUndefined();
    expect(kvAdd(c, "+ Add sort")).toBeUndefined();
    expect(fieldRowByLabel(c, "Filter")).toBeDefined();
    expect(fieldRowByLabel(c, "Sort")).toBeDefined();
  });

  test("Edit template button moves the selection into the map node", async () => {
    const tab = openDoc(repeaterDoc(), ["children", 0]);
    const c = await renderPanel();
    pointer(actionButtonByText(c, "Edit template")!, "click");
    expect(tab.session.selection).toEqual(["children", 0, "map"]);
  });

  test("bound Items row de-escalates to literal, restoring the signal default", async () => {
    openDoc(repeaterDoc(), ["children", 0]);
    const c = await renderPanel();
    const row = fieldRowByLabel(c, "Items")!;
    const mode = row.querySelector(".dynamic-slot-mode") as HTMLInputElement;
    expect(mode).not.toBeNull();
    expect(row.querySelector("sp-picker")).not.toBeNull();

    mode.value = "literal";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    // Default is an array → JSON stringified static value
    expect((docNow().children as any[])[0].items).toBe('["a"]');
  });

  test("static Items row binds to the first available signal via ref mode", async () => {
    openDoc(repeaterDoc({ items: "static" }), ["children", 0]);
    const c = await renderPanel();
    const row = fieldRowByLabel(c, "Items")!;
    const mode = row.querySelector(".dynamic-slot-mode") as HTMLInputElement;
    mode.value = "ref";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as any[])[0].items).toEqual({ $ref: "#/state/posts" });
  });

  test("signal picker change rebinds; empty value clears the property", async () => {
    openDoc(repeaterDoc(), ["children", 0]);
    let c = await renderPanel();
    let picker = fieldRowByLabel(c, "Items")!.querySelector("sp-picker") as HTMLInputElement;
    picker.value = "#/state/posts";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as any[])[0].items).toEqual({ $ref: "#/state/posts" });

    c = await renderPanel();
    picker = fieldRowByLabel(c, "Items")!.querySelector("sp-picker") as HTMLInputElement;
    picker.value = "";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as any[])[0].items).toBeUndefined();
  });

  test("handler and Function state entries are excluded from signal options", async () => {
    openDoc(
      {
        children: { $prototype: "Array", items: { $ref: "#/state/posts" }, map: { tagName: "li" } },
        state: {
          fn: { $prototype: "Function", arguments: [], body: "" },
          onClick: { $handler: "x" },
          posts: { default: [] },
        },
        tagName: "ul",
      },
      ["children", 0],
    );
    const c = await renderPanel();
    // First picker is the ref widget; the trailing mode menu is a separate picker.
    const items = [
      ...fieldRowByLabel(c, "Items")!.querySelector("sp-picker")!.querySelectorAll("sp-menu-item"),
    ].map((m) => m.textContent?.trim());
    expect(items).toEqual(["posts"]);
  });

  test("filter and sort rows commit edits and clear when emptied", async () => {
    openDoc(repeaterDoc({ filter: "a > 1", sort: "name" }), ["children", 0]);
    let c = await renderPanel();
    const filterField = fieldRowByLabel(c, "Filter")!.querySelector(
      "sp-textfield",
    ) as HTMLInputElement;
    filterField.value = "a > 2";
    filterField.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as any[])[0].filter).toBe("a > 2");

    c = await renderPanel();
    const sortField = fieldRowByLabel(c, "Sort")!.querySelector("sp-textfield") as HTMLInputElement;
    sortField.value = "";
    sortField.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as any[])[0].sort).toBeUndefined();
  });

  test("unbinding from a scalar (non-object) state def clears the value", async () => {
    openDoc(
      {
        children: { $prototype: "Array", items: { $ref: "#/state/n" }, map: { tagName: "li" } },
        state: { n: 5 },
        tagName: "ul",
      },
      ["children", 0],
    );
    const c = await renderPanel();
    const mode = fieldRowByLabel(c, "Items")!.querySelector(
      ".dynamic-slot-mode",
    ) as HTMLInputElement;
    mode.value = "literal";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as any[])[0].items).toBeUndefined();
  });

  test("unbinding with no default falls back to clearing the property", async () => {
    openDoc(
      {
        children: { $prototype: "Array", items: { $ref: "#/state/posts" }, map: { tagName: "li" } },
        state: { posts: {} },
        tagName: "ul",
      },
      ["children", 0],
    );
    const c = await renderPanel();
    const mode = fieldRowByLabel(c, "Items")!.querySelector(
      ".dynamic-slot-mode",
    ) as HTMLInputElement;
    mode.value = "literal";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as any[])[0].items).toBeUndefined();
  });
});

// ─── Switch section ───────────────────────────────────────────────────────────

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
  };
}

describe("switch section", () => {
  test("renders the expression row and case list", async () => {
    openDoc(switchDoc(), ["children", 0, "map"]);
    const c = await renderPanel();
    const sw = section(c, "Switch")!;
    expect(sw).not.toBeNull();
    expect(fieldRowByLabel(sw, "Expression")).toBeDefined();
    const caseInputs = [...sw.querySelectorAll("input.field-input")].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(caseInputs).toEqual(["alpha", "beta"]);
  });

  test("edit-case arrow navigates the selection to the case", async () => {
    const tab = openDoc(switchDoc(), ["children", 0, "map"]);
    const c = await renderPanel();
    pointer(c.querySelector('[title="Edit case"]')!, "click");
    expect(tab.session.selection).toEqual(["children", 0, "map", "cases", "alpha"]);
  });

  test("✕ removes a case and + Add case appends a numbered one", async () => {
    openDoc(switchDoc(), ["children", 0, "map"]);
    let c = await renderPanel();
    const remove = [...c.querySelectorAll("span")].find((s) => s.textContent === "✕");
    pointer(remove!, "click");
    expect(Object.keys((docNow().children as any[])[0].map.cases)).toEqual(["beta"]);

    c = await renderPanel();
    pointer(kvAdd(c, "+ Add case")!, "click");
    expect(Object.keys((docNow().children as any[])[0].map.cases)).toEqual(["beta", "case2"]);
  });

  test("inside a map template, binding the expression offers $map signals", async () => {
    openDoc(switchDoc(), ["children", 0, "map"]);
    let c = await renderPanel();
    const row = fieldRowByLabel(section(c, "Switch")!, "Expression")!;
    // No state defs → ref mode falls through to the extra $map signals
    const mode = row.querySelector(".dynamic-slot-mode") as HTMLInputElement;
    mode.value = "ref";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as any[])[0].map.$switch).toEqual({ $ref: "$map/item" });

    c = await renderPanel();
    const picker = fieldRowByLabel(section(c, "Switch")!, "Expression")!.querySelector(
      "sp-picker",
    )!;
    const opts = [...picker.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value"));
    expect(opts).toContain("$map/item");
    expect(opts).toContain("$map/index");
    expect(picker.querySelector("sp-menu-divider")).not.toBeNull();
  });
});

// ─── Component props section ──────────────────────────────────────────────────

function registerCard(overrides: Record<string, unknown> = {}) {
  componentRegistry.push({
    path: "components/my-card.json",
    props: [
      { name: "title", type: "string" },
      { description: "Show ribbon", name: "featured", type: "boolean" },
      { name: "count", type: "number" },
      { name: "variant", type: "'plain' | 'fancy'" },
      { format: "image", name: "image", type: "string" },
      { format: "color", name: "tint", type: "string" },
      { format: "date", name: "published", type: "string" },
    ],
    source: "local",
    tagName: "my-card",
    ...overrides,
  } as never);
}

function cardDoc($props: Record<string, unknown> = {}) {
  return {
    children: [{ $props, tagName: "my-card" }],
    state: { username: { default: "kevin" } },
    tagName: "div",
  };
}

describe("component props section", () => {
  test("unknown component → 'Component not found'", async () => {
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    expect(section(c, "Component Props")!.textContent).toContain("Component not found");
  });

  test("empty props list → 'No props defined'", async () => {
    componentRegistry.push({
      path: "components/empty.json",
      props: [],
      source: "local",
      tagName: "my-card",
    } as never);
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    expect(section(c, "Component Props")!.textContent).toContain("No props defined");
  });

  test("renders one widget per prop with the right control types", async () => {
    registerCard();
    openDoc(cardDoc({ title: "Hi" }), ["children", 0]);
    const c = await renderPanel();
    const sec = section(c, "Component Props")!;
    expect(sec.querySelector('[data-prop="title"] sp-textfield')).not.toBeNull();
    expect(sec.querySelector('[data-prop="featured"] sp-checkbox')).not.toBeNull();
    expect(sec.querySelector('[data-prop="count"] sp-number-field')).not.toBeNull();
    expect(sec.querySelector('[data-prop="variant"] jx-value-selector')).not.toBeNull();
    expect(sec.querySelector('[data-prop="image"] .media-picker')).not.toBeNull();
    expect(sec.querySelector('[data-prop="tint"]')).not.toBeNull();
    const published = sec.querySelector('[data-prop="published"] sp-textfield');
    expect(published?.getAttribute("placeholder")).toBe("YYYY-MM-DD");
    await flush();
  });

  test("text prop commits into $props on change; clear dot removes it", async () => {
    registerCard();
    openDoc(cardDoc({ title: "Hi" }), ["children", 0]);
    let c = await renderPanel();
    const sec = section(c, "Component Props")!;
    const field = sec.querySelector('[data-prop="title"] sp-textfield') as HTMLInputElement;
    field.value = "Updated";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toBe("Updated");

    c = await renderPanel();
    pointer(c.querySelector('[title="Clear title"]')!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.$props).toBeUndefined();
  });

  test("boolean prop checkbox sets true and clears on uncheck", async () => {
    registerCard();
    openDoc(cardDoc({ featured: true }), ["children", 0]);
    let c = await renderPanel();
    let box = section(c, "Component Props")!.querySelector(
      '[data-prop="featured"] sp-checkbox',
    ) as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props).toBeUndefined();

    c = await renderPanel();
    box = section(c, "Component Props")!.querySelector(
      '[data-prop="featured"] sp-checkbox',
    ) as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props!.featured).toBe(true);
  });

  test("enum prop commits via jx-value-selector change detail", async () => {
    registerCard();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    const sel = section(c, "Component Props")!.querySelector(
      '[data-prop="variant"] jx-value-selector',
    )!;
    sel.dispatchEvent(new CustomEvent("change", { bubbles: true, detail: { value: "fancy" } }));
    expect((docNow().children as JxMutableNode[])[0]!.$props!.variant).toBe("fancy");
  });

  test("date prop commits via its text field", async () => {
    registerCard();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    const field = section(c, "Component Props")!.querySelector(
      '[data-prop="published"] sp-textfield',
    ) as HTMLInputElement;
    field.value = "2026-06-12";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props!.published).toBe("2026-06-12");
  });

  test("bind toggle binds a prop to the first signal and back to its default", async () => {
    registerCard();
    openDoc(cardDoc({ title: "Hi" }), ["children", 0]);
    let c = await renderPanel();
    let row = section(c, "Component Props")!.querySelector('[data-prop="title"]')!;
    pointer(row.querySelector("sp-action-button")!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toEqual({
      $ref: "#/state/username",
    });

    c = await renderPanel();
    row = section(c, "Component Props")!.querySelector('[data-prop="title"]')!;
    expect(row.querySelector("sp-action-button")!.getAttribute("title")).toContain("Unbind");
    pointer(row.querySelector("sp-action-button")!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toBe("kevin");
  });

  test("bound prop renders a signal picker that rebinds or clears", async () => {
    registerCard();
    openDoc(cardDoc({ title: { $ref: "#/state/username" } }), ["children", 0]);
    let c = await renderPanel();
    let picker = section(c, "Component Props")!.querySelector(
      '[data-prop="title"] sp-picker',
    ) as HTMLInputElement;
    expect(picker).not.toBeNull();
    picker.value = "#/state/username";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toEqual({
      $ref: "#/state/username",
    });

    c = await renderPanel();
    picker = section(c, "Component Props")!.querySelector(
      '[data-prop="title"] sp-picker',
    ) as HTMLInputElement;
    picker.value = "";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props).toBeUndefined();
  });

  test("npm components write props into attributes instead of $props", async () => {
    componentRegistry.push({
      props: [{ name: "label", type: "string" }],
      source: "npm",
      tagName: "sl-button",
    } as never);
    openDoc({ children: [{ attributes: { label: "Hi" }, tagName: "sl-button" }], tagName: "div" }, [
      "children",
      0,
    ]);
    let c = await renderPanel();
    let field = section(c, "Component Props")!.querySelector(
      '[data-prop="label"] sp-textfield',
    ) as HTMLInputElement;
    field.value = "Click me";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.label).toBe("Click me");

    // Empty value removes the attribute
    c = await renderPanel();
    field = section(c, "Component Props")!.querySelector(
      '[data-prop="label"] sp-textfield',
    ) as HTMLInputElement;
    field.value = "";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.label).toBeUndefined();

    // Npm comp without a path → no Edit definition link
    c = await renderPanel();
    expect(kvAdd(section(c, "Component Props")!, "Edit definition")).toBeUndefined();
  });

  test("inside a map template, props bind to $map signals when no state defs exist", async () => {
    registerCard();
    openDoc(
      { children: { $prototype: "Array", items: [], map: { tagName: "my-card" } }, tagName: "div" },
      ["children", 0, "map"],
    );
    let c = await renderPanel();
    let row = section(c, "Component Props")!.querySelector('[data-prop="title"]')!;
    pointer(row.querySelector("sp-action-button")!, "click");
    expect((docNow().children as any[])[0].map.$props.title).toEqual({ $ref: "$map/item" });

    c = await renderPanel();
    row = section(c, "Component Props")!.querySelector('[data-prop="title"]')!;
    const opts = [...row.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value"));
    expect(opts).toEqual(["$map/item", "$map/index"]);
    expect(row.querySelector("sp-menu-divider")).not.toBeNull();
  });

  test("Edit definition link navigates to the component file", async () => {
    registerCard();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    pointer(kvAdd(section(c, "Component Props")!, "Edit definition")!, "click");
    expect(navCalls).toEqual(["components/my-card.json"]);
  });
});

// ─── HTML attribute sections ──────────────────────────────────────────────────

describe("html attribute sections", () => {
  test("only sections applicable to the tag are rendered", async () => {
    openDoc({ children: [{ tagName: "p" }], tagName: "div" }, ["children", 0]);
    const c = await renderPanel();
    expect(section(c, "Identity")).not.toBeNull();
    expect(section(c, "Accessibility")).not.toBeNull();
    expect(section(c, "Link")).toBeNull();
    expect(section(c, "Table")).toBeNull();
  });

  test("a set attribute auto-opens its section and marks it with a dot", async () => {
    openDoc({ children: [{ attributes: { href: "/x" }, tagName: "a" }], tagName: "div" }, [
      "children",
      0,
    ]);
    const c = await renderPanel();
    const link = section(c, "Link")!;
    expect(link).not.toBeNull();
    expect(link.hasAttribute("open")).toBe(true);
    expect(link.querySelector(".set-dot--section")).not.toBeNull();
  });

  test("text attribute commits via its widget and clears via the set-dot", async () => {
    // <link> carries href in html-meta but is NOT an anchor, so it keeps the raw text widget
    // (the Link-target composite is scoped to a/area only).
    openDoc({ children: [{ attributes: { href: "/x" }, tagName: "link" }], tagName: "div" }, [
      "children",
      0,
    ]);
    let c = await renderPanel();
    const field = section(c, "Link")!.querySelector(
      '[data-prop="href"] sp-textfield',
    ) as HTMLInputElement;
    field.value = "/about";
    // RenderTextInput commits via a 400ms debounced @input handler
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(460);
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("/about");

    c = await renderPanel();
    pointer(c.querySelector('[title="Clear href"]')!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.href).toBeUndefined();
  });

  test("boolean attribute renders a checkbox and clears via the set-dot", async () => {
    openDoc(
      { children: [{ attributes: { required: "required" }, tagName: "input" }], tagName: "div" },
      ["children", 0],
    );
    let c = await renderPanel();
    const row = section(c, "Form")!.querySelector('[data-prop="required"]')!;
    expect(row.querySelector("sp-checkbox")).not.toBeNull();

    // Unchecking removes the attribute
    const box = row.querySelector("sp-checkbox") as unknown as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.required).toBeUndefined();

    // Re-render with a value again and clear via the dot
    openDoc(
      { children: [{ attributes: { required: "required" }, tagName: "input" }], tagName: "div" },
      ["children", 0],
    );
    c = await renderPanel();
    pointer(c.querySelector('[title="Clear required"]')!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.required).toBeUndefined();
  });
});

// ─── Attribute dynamic slots (fx affordance) ──────────────────────────────────

describe("attribute dynamic slots", () => {
  function linkDoc(href: unknown = "/x") {
    return {
      children: [{ attributes: { href }, tagName: "link" }],
      state: { alt: { default: "/alt" }, url: { default: "/x" } },
      tagName: "div",
    };
  }

  function hrefRow(c: Element): HTMLElement {
    return c.querySelector('[data-prop="href"]') as HTMLElement;
  }

  test("attribute rows offer literal, ref, and template modes", async () => {
    openDoc(linkDoc(), ["children", 0]);
    const c = await renderPanel();
    const mode = hrefRow(c).querySelector(".dynamic-slot-mode")!;
    const caps = [...mode.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value"));
    expect(caps).toEqual(["literal", "ref", "template"]);
  });

  test("switching to ref mode binds the first signal; the picker rebinds", async () => {
    openDoc(linkDoc(), ["children", 0]);
    let c = await renderPanel();
    const mode = hrefRow(c).querySelector(".dynamic-slot-mode") as HTMLInputElement;
    mode.value = "ref";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toEqual({
      $ref: "#/state/alt",
    });

    c = await renderPanel();
    const picker = hrefRow(c).querySelector("sp-picker") as HTMLInputElement;
    picker.value = "#/state/url";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toEqual({
      $ref: "#/state/url",
    });
  });

  test("de-escalating a bound attribute to literal clears it", async () => {
    openDoc(linkDoc({ $ref: "#/state/url" }), ["children", 0]);
    const c = await renderPanel();
    const mode = hrefRow(c).querySelector(".dynamic-slot-mode") as HTMLInputElement;
    mode.value = "literal";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.href).toBeUndefined();
  });

  test("template-valued attribute renders the template textfield and commits edits", async () => {
    openDoc(linkDoc("${state.url}/feed"), ["children", 0]);
    const c = await renderPanel();
    const mode = hrefRow(c).querySelector(".dynamic-slot-mode") as HTMLInputElement;
    expect(mode.value).toBe("template");
    const tf = hrefRow(c).querySelector("sp-textfield") as HTMLInputElement;
    expect(tf.value).toBe("${state.url}/feed");
    tf.value = "${state.alt}/feed";
    tf.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("${state.alt}/feed");
  });

  test("boolean attribute rows carry the mode menu and bind via ref", async () => {
    openDoc(
      {
        children: [{ attributes: { required: "required" }, tagName: "input" }],
        state: { mandatory: { default: true } },
        tagName: "div",
      },
      ["children", 0],
    );
    const c = await renderPanel();
    const rowEl = section(c, "Form")!.querySelector('[data-prop="required"]')!;
    const mode = rowEl.querySelector(".dynamic-slot-mode") as HTMLInputElement;
    expect(mode).not.toBeNull();
    mode.value = "ref";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.required).toEqual({
      $ref: "#/state/mandatory",
    });
  });

  test("textContent row binds via ref mode and renders templates", async () => {
    openDoc(
      {
        children: [{ tagName: "p", textContent: "Hello" }],
        state: { msg: { default: "hi" } },
        tagName: "div",
      },
      ["children", 0],
    );
    let c = await renderPanel();
    const mode = c.querySelector(
      '[data-prop="textContent"] .dynamic-slot-mode',
    ) as HTMLInputElement;
    expect(mode).not.toBeNull();
    mode.value = "ref";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.textContent).toEqual({
      $ref: "#/state/msg",
    });

    // Template-valued text content renders the raw ${} textfield
    openDoc({ children: [{ tagName: "p", textContent: "${state.msg}!" }], tagName: "div" }, [
      "children",
      0,
    ]);
    c = await renderPanel();
    const tf = c.querySelector('[data-prop="textContent"] sp-textfield') as HTMLInputElement;
    expect(tf.value).toBe("${state.msg}!");
  });
});

// ─── Link-target control (anchor href / target) ───────────────────────────────

function pageRoutesSetup(files: Record<string, string> = {}) {
  resetStudioState({ isSiteProject: true, projectConfig: null });
  installMockPlatform({
    listDirectory: (async (dir: string) => {
      if (dir === "pages") {
        return [
          { name: "index.json", path: "pages/index.json", type: "file" },
          { name: "about.json", path: "pages/about.json", type: "file" },
          { name: "notes.txt", path: "pages/notes.txt", type: "file" },
          { name: "blog", path: "pages/blog", type: "directory" },
        ];
      }
      if (dir === "pages/blog") {
        return [
          { name: "index.json", path: "pages/blog/index.json", type: "file" },
          { name: "[slug].json", path: "pages/blog/[slug].json", type: "file" },
        ];
      }
      return [];
    }) as never,
    ...files,
  });
}

function anchorDoc(attrs: Record<string, unknown>) {
  return { children: [{ attributes: attrs, tagName: "a" }], tagName: "div" };
}

function linkField(root: Element): HTMLElement | null {
  return root.querySelector('[data-prop="href"] .link-target-field');
}

describe("link-target control", () => {
  test("selected <a> renders the composite kind selector + value input", async () => {
    openDoc(anchorDoc({ href: "/about/" }), ["children", 0]);
    const c = await renderPanel();
    const field = linkField(c)!;
    expect(field).not.toBeNull();
    const kind = field.querySelector("sp-picker.link-target-kind") as HTMLInputElement;
    expect(kind.getAttribute("value")).toBe("internal");
    const kindOpts = [...kind.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value"));
    expect(kindOpts).toEqual(["internal", "external", "anchor", "mailto", "tel"]);
    // Internal kind → route picker (not a textfield)
    expect(field.querySelector("sp-picker.link-target-value")).not.toBeNull();
  });

  test("changing kind to Email recomposes the href with the mailto scheme", async () => {
    openDoc(anchorDoc({ href: "a@b.com" }), ["children", 0]);
    const c = await renderPanel();
    const kind = linkField(c)!.querySelector("sp-picker.link-target-kind") as HTMLInputElement;
    kind.value = "mailto";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("mailto:a@b.com");
  });

  test("entering an external URL composes and commits the href", async () => {
    openDoc(anchorDoc({ href: "https://old.com" }), ["children", 0]);
    const c = await renderPanel();
    const field = linkField(c)!;
    const input = field.querySelector("sp-textfield.link-target-value") as HTMLInputElement;
    expect(
      (field.querySelector("sp-picker.link-target-kind") as HTMLInputElement).getAttribute("value"),
    ).toBe("external");
    input.value = "https://new.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(460);
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("https://new.com");
  });

  test("an anchor input target composes a #fragment href", async () => {
    openDoc(anchorDoc({ href: "#top" }), ["children", 0]);
    const c = await renderPanel();
    const field = linkField(c)!;
    const input = field.querySelector("sp-textfield.link-target-value") as HTMLInputElement;
    expect(input.value).toBe("top");
    input.value = "footer";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(460);
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("#footer");
  });

  test("clearing the value via the set-dot removes the href attribute", async () => {
    openDoc(anchorDoc({ href: "https://x.com" }), ["children", 0]);
    const c = await renderPanel();
    pointer(c.querySelector('[data-prop="href"] [title="Clear href"]')!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.href).toBeUndefined();
  });

  test("Internal picker lists routes derived from the pages/ tree", async () => {
    pageRoutesSetup();
    const tab = resetWorkspaceWithTab(anchorDoc({ href: "/about/" }) as JxMutableNode, {
      documentPath: "pages/index.json",
    });
    tab.session.selection = ["children", 0] as never;

    // First pass kicks off the async recursive walk; the route options aren't present yet.
    await renderPanel();
    await flush();

    const c = await renderPanel();
    const picker = linkField(c)!.querySelector("sp-picker.link-target-value")!;
    const routes = [...picker.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value"));
    expect(routes).toContain("/");
    expect(routes).toContain("/about/");
    expect(routes).toContain("/blog/");
    expect(routes).toContain("/blog/:slug");
    // .txt files are not routes
    expect(routes).not.toContain("/notes/");
  });

  test("choosing a route from the Internal picker commits it as the href", async () => {
    pageRoutesSetup();
    const tab = resetWorkspaceWithTab(anchorDoc({ href: "/about/" }) as JxMutableNode, {
      documentPath: "pages/index.json",
    });
    tab.session.selection = ["children", 0] as never;
    await renderPanel();
    await flush();

    const c = await renderPanel();
    const picker = linkField(c)!.querySelector("sp-picker.link-target-value") as HTMLInputElement;
    picker.value = "/blog/";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("/blog/");
  });

  test("a bound href ($ref) falls back to the raw widget, not the Link-target control", async () => {
    openDoc(anchorDoc({ href: { $ref: "#/state/url" } }), ["children", 0]);
    const c = await renderPanel();
    expect(linkField(c)).toBeNull();
    // The raw widget path renders inside the href row
    expect(c.querySelector('[data-prop="href"]')).not.toBeNull();
  });

  test("a template-string href (${…}) falls back to the raw widget", async () => {
    openDoc(anchorDoc({ href: "${item.url}" }), ["children", 0]);
    const c = await renderPanel();
    expect(linkField(c)).toBeNull();
    expect(c.querySelector('[data-prop="href"] sp-textfield')).not.toBeNull();
  });

  test("the target attribute renders a real enum sp-picker with all four keywords", async () => {
    openDoc(anchorDoc({ href: "/x", target: "_blank" }), ["children", 0]);
    const c = await renderPanel();
    const picker = section(c, "Link")!.querySelector(
      '[data-prop="target"] sp-picker.link-target-window',
    ) as HTMLInputElement;
    expect(picker).not.toBeNull();
    expect(picker.getAttribute("value")).toBe("_blank");
    const opts = [...picker.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value"));
    expect(opts).toEqual(["_self", "_blank", "_parent", "_top"]);
  });

  test("target picker change commits; empty selection clears the attribute", async () => {
    openDoc(anchorDoc({ href: "/x", target: "_blank" }), ["children", 0]);
    let c = await renderPanel();
    let picker = section(c, "Link")!.querySelector(
      '[data-prop="target"] sp-picker.link-target-window',
    ) as HTMLInputElement;
    picker.value = "_self";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.target).toBe("_self");

    c = await renderPanel();
    picker = section(c, "Link")!.querySelector(
      '[data-prop="target"] sp-picker.link-target-window',
    ) as HTMLInputElement;
    picker.value = "";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.target).toBeUndefined();
  });

  test("layout listing failure degrades the route picker to an empty list", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: null });
    installMockPlatform({
      listDirectory: (async () => {
        throw new Error("nope");
      }) as never,
    });
    const tab = resetWorkspaceWithTab(anchorDoc({ href: "/about/" }) as JxMutableNode, {
      documentPath: "pages/index.json",
    });
    tab.session.selection = ["children", 0] as never;
    await renderPanel();
    await flush();

    const c = await renderPanel();
    const picker = linkField(c)!.querySelector("sp-picker.link-target-value")!;
    // Only the "known value" option for the current href survives; no enumerated routes.
    const routes = [...picker.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value"));
    expect(routes).toEqual(["/about/"]);
  });
});

// ─── Custom attributes section ────────────────────────────────────────────────

describe("custom attributes section", () => {
  test("unknown attributes land in the auto-opened Custom section", async () => {
    openDoc(
      { children: [{ attributes: { "data-x": "1", id: "foo" }, tagName: "div" }], tagName: "div" },
      ["children", 0],
    );
    const c = await renderPanel();
    const custom = section(c, "Custom")!;
    expect(custom).not.toBeNull();
    expect(custom.hasAttribute("open")).toBe(true);
    expect(custom.querySelector(".set-dot--section")).not.toBeNull();
    // Only data-x is custom; id is a known html attribute
    const keys = [...custom.querySelectorAll(".kv-row .kv-key")].map((k) => (k as any).value);
    expect(keys).toEqual(["data-x"]);
  });

  test("component prop names are excluded from custom attributes", async () => {
    registerCard();
    openDoc({ children: [{ attributes: { title2: "x" }, tagName: "my-card" }], tagName: "div" }, [
      "children",
      0,
    ]);
    const c = await renderPanel();
    const keys = [...section(c, "Custom")!.querySelectorAll(".kv-row .kv-key")].map(
      (k) => (k as any).value,
    );
    expect(keys).toEqual(["title2"]);
  });

  test("delete button removes the attribute immediately", async () => {
    openDoc({ children: [{ attributes: { "data-x": "1" }, tagName: "div" }], tagName: "div" }, [
      "children",
      0,
    ]);
    const c = await renderPanel();
    pointer(section(c, "Custom")!.querySelector(".kv-row sp-action-button")!, "click");
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.["data-x"]).toBeUndefined();
  });

  test("+ Add attribute click runs without mutating (empty value is a delete)", async () => {
    openDoc({ children: [{ attributes: { "data-x": "1" }, tagName: "div" }], tagName: "div" }, [
      "children",
      0,
    ]);
    const c = await renderPanel();
    pointer(kvAdd(section(c, "Custom")!, "+ Add attribute")!, "click");
    expect(Object.keys((docNow().children as JxMutableNode[])[0]!.attributes!)).toEqual(["data-x"]);
  });
});

// ─── Custom element doc sections (root) ───────────────────────────────────────

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
  };
}

describe("custom element document sections", () => {
  test("observed attributes lists only state entries with an attribute", async () => {
    openDoc(widgetDoc(), []);
    const c = await renderPanel();
    const observed = section(c, "Observed Attributes")!;
    expect(observed).not.toBeNull();
    expect(observed.textContent).toContain("label");
    expect(observed.textContent).toContain("string");
    expect(observed.textContent).toContain("reflects");
    expect(observed.textContent).not.toContain("plain");
  });

  test("no attribute entries → empty-state hint", async () => {
    openDoc(widgetDoc({ state: { plain: { default: 1 } } }), []);
    const c = await renderPanel();
    expect(section(c, "Observed Attributes")!.textContent).toContain("No attributes declared");
  });

  test("CSS Properties section lists only custom properties", async () => {
    openDoc(widgetDoc(), []);
    const c = await renderPanel();
    const cssProps = section(c, "CSS Properties")!;
    expect(cssProps).not.toBeNull();
    expect(cssProps.textContent).toContain("--accent");
    expect(cssProps.textContent).toContain("red");
    expect(cssProps.textContent).not.toContain("blue");
  });

  test("CSS Properties section is omitted without custom properties", async () => {
    openDoc(widgetDoc({ style: { color: "blue" } }), []);
    const c = await renderPanel();
    expect(section(c, "CSS Properties")).toBeNull();
  });

  test("CSS Parts section collects part attributes from the tree", async () => {
    openDoc(widgetDoc(), []);
    const c = await renderPanel();
    const parts = section(c, "CSS Parts")!;
    expect(parts).not.toBeNull();
    expect(parts.textContent).toContain("root");
    expect(parts.textContent).toContain("icon");
    expect(parts.textContent).toContain("span");
  });

  test("CSS Parts section is omitted when no parts exist", async () => {
    openDoc(widgetDoc({ attributes: {}, children: [{ tagName: "span" }] }), []);
    const c = await renderPanel();
    expect(section(c, "CSS Parts")).toBeNull();
  });

  test("custom-element sections are omitted for non-root selections", async () => {
    openDoc(widgetDoc(), ["children", 0]);
    const c = await renderPanel();
    expect(section(c, "Observed Attributes")).toBeNull();
    expect(section(c, "CSS Properties")).toBeNull();
    expect(section(c, "CSS Parts")).toBeNull();
    expect(section(c, "Media")).toBeNull();
  });
});

// ─── Media breakpoints ────────────────────────────────────────────────────────

describe("media section", () => {
  test("renders base width and breakpoint rows with friendly names", async () => {
    openDoc(
      { $media: { "--": "320px", "--tablet": "(min-width: 768px)" }, children: [], tagName: "div" },
      [],
    );
    const c = await renderPanel();
    const media = section(c, "Media")!;
    expect(media).not.toBeNull();
    const base = media.querySelector(".kv-row input.field-input") as HTMLInputElement;
    expect(base.value).toBe("320px");
    // The friendly name lives in the breakpoint name input's value (live directive)
    const rawLabel = media.querySelector(".bp-raw-label")!;
    const nameInput = rawLabel.parentElement!.querySelector(
      "input.field-input",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("Tablet");
    expect(media.querySelector(".bp-raw-label")!.textContent).toBe("--tablet");
    expect((media.querySelector(".bp-query-input") as HTMLInputElement).value).toBe(
      "(min-width: 768px)",
    );
  });

  test("✕ deletes the base width and breakpoints", async () => {
    openDoc(
      { $media: { "--": "320px", "--tablet": "(min-width: 768px)" }, children: [], tagName: "div" },
      [],
    );
    let c = await renderPanel();
    const dels = [...section(c, "Media")!.querySelectorAll(".kv-del")];
    pointer(dels[0]!, "click"); // Base width delete
    expect((docNow() as any).$media["--"]).toBeUndefined();

    c = await renderPanel();
    pointer(section(c, "Media")!.querySelector(".kv-del")!, "click"); // Breakpoint delete
    expect((docNow() as any).$media).toBeUndefined();
  });

  test("add breakpoint flow: preview, add, and state reset", async () => {
    openDoc({ children: [], tagName: "div" }, []);
    let c = await renderPanel();
    pointer(kvAdd(section(c, "Media")!, "+ Add breakpoint")!, "click");
    expect(view.showAddBreakpointForm).toBe(true);

    c = await renderPanel();
    const media = section(c, "Media")!;
    const nameInput = media.querySelector(
      'input[placeholder="Name (e.g. Tablet)"]',
    ) as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    nameInput!.value = "Wide Screen";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.addBreakpointPreview).toBe("--wide-screen");

    const addBtn = [...media.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add"),
    )!;
    pointer(addBtn, "click");
    expect((docNow() as any).$media["--wide-screen"]).toBe("(min-width: 768px)");
    expect(view.showAddBreakpointForm).toBe(false);
    expect(view.addBreakpointPreview).toBe("");
  });

  test("add with an empty name is a no-op and keeps the form open", async () => {
    openDoc({ children: [], tagName: "div" }, []);
    view.showAddBreakpointForm = true;
    const c = await renderPanel();
    const addBtn = [...section(c, "Media")!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add"),
    )!;
    pointer(addBtn, "click");
    expect((docNow() as any).$media).toBeUndefined();
    expect(view.showAddBreakpointForm).toBe(true);
  });

  test("cancel hides the form without touching the doc", async () => {
    openDoc({ children: [], tagName: "div" }, []);
    view.showAddBreakpointForm = true;
    view.addBreakpointPreview = "--x";
    const c = await renderPanel();
    const cancelBtn = [...section(c, "Media")!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Cancel"),
    )!;
    pointer(cancelBtn, "click");
    expect(view.showAddBreakpointForm).toBe(false);
    expect(view.addBreakpointPreview).toBe("");
    expect((docNow() as any).$media).toBeUndefined();
  });
});

// ─── Page section (site projects) ─────────────────────────────────────────────

function sitePageSetup(layoutFiles = ["base.json", "two.json", "notes.txt"]) {
  resetStudioState({
    isSiteProject: true,
    projectConfig: { defaults: { layout: "./layouts/base.json" } },
  });
  installMockPlatform({
    listDirectory: (async (dir: string) =>
      dir === "layouts"
        ? [
            ...layoutFiles.map((name) => ({ name, type: "file" })),
            { name: "sub", type: "directory" },
          ]
        : []) as never,
  });
}

describe("page section", () => {
  test("loads layout entries async then renders the picker with defaults", async () => {
    sitePageSetup();
    const tab = resetWorkspaceWithTab({ children: [], tagName: "div" } as JxMutableNode, {
      documentPath: "pages/index.json",
    });
    tab.session.selection = [] as never;

    let c = await renderPanel();
    // First pass kicks off the async load; section not yet rendered
    expect(section(c, "Page")).toBeNull();
    await flush();

    c = await renderPanel();
    const page = section(c, "Page")!;
    expect(page).not.toBeNull();
    const picker = page.querySelector("sp-picker")!;
    expect(picker.getAttribute("value")).toBe("__default__");
    const items = [...page.querySelectorAll("sp-menu-item")].map((m) => m.textContent?.trim());
    expect(items[0]).toBe("Default (base)");
    expect(items[1]).toBe("None");
    expect(items).toContain("base");
    expect(items).toContain("two");
    expect(items).not.toContain("notes");
    expect(items).not.toContain("sub");
    // Default layout is effective → slot note shown
    expect(page.textContent).toContain("Wraps page content");
  });

  test("picker change sets, nulls, and resets $layout", async () => {
    sitePageSetup();
    const open = () => {
      const tab = resetWorkspaceWithTab({ children: [], tagName: "div" } as JxMutableNode, {
        documentPath: "pages/index.json",
      });
      tab.session.selection = [] as never;
      return tab;
    };
    open();
    await renderPanel();
    await flush();

    let c = await renderPanel();
    let picker = section(c, "Page")!.querySelector("sp-picker") as HTMLInputElement;
    picker.value = "./layouts/two.json";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow() as any).$layout).toBe("./layouts/two.json");

    c = await renderPanel();
    picker = section(c, "Page")!.querySelector("sp-picker") as HTMLInputElement;
    expect(picker.getAttribute("value")).toBe("./layouts/two.json");
    picker.value = "__none__";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow() as any).$layout).toBe(false);

    c = await renderPanel();
    picker = section(c, "Page")!.querySelector("sp-picker") as HTMLInputElement;
    expect(picker.getAttribute("value")).toBe("__none__");
    picker.value = "__default__";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow() as any).$layout).toBeUndefined();
  });

  test("set-dot resets an explicit layout to the default", async () => {
    sitePageSetup();
    const tab = resetWorkspaceWithTab(
      { $layout: "./layouts/two.json", children: [], tagName: "div" } as never,
      { documentPath: "pages/index.json" },
    );
    tab.session.selection = [] as never;
    await renderPanel();
    await flush();

    const c = await renderPanel();
    pointer(section(c, "Page")!.querySelector('[title="Reset to default"]')!, "click");
    expect((docNow() as any).$layout).toBeUndefined();
  });

  test("layout listing failure degrades to an empty list", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: null });
    installMockPlatform({
      listDirectory: (async () => {
        throw new Error("nope");
      }) as never,
    });
    const tab = resetWorkspaceWithTab({ children: [], tagName: "div" } as JxMutableNode, {
      documentPath: "./pages/about.json",
    });
    tab.session.selection = [] as never;
    await renderPanel();
    await flush();

    const c = await renderPanel();
    const page = section(c, "Page")!;
    expect(page).not.toBeNull();
    const items = [...page.querySelectorAll("sp-menu-item")].map((m) => m.textContent?.trim());
    expect(items).toEqual(["Default", "None"]);
  });

  test("no Page section for non-page docs or non-site projects", async () => {
    sitePageSetup();
    openDoc({ children: [], tagName: "div" }, []); // DocumentPath /project/index.json
    let c = await renderPanel();
    await flush();
    expect(section(c, "Page")).toBeNull();

    resetStudioState({ isSiteProject: false });
    const tab = resetWorkspaceWithTab({ children: [], tagName: "div" } as JxMutableNode, {
      documentPath: "pages/index.json",
    });
    tab.session.selection = [] as never;
    c = await renderPanel();
    await flush();
    expect(section(c, "Page")).toBeNull();
  });
});

// ─── Debounced edits (real timers, consolidated) ──────────────────────────────

describe("debounced edits", () => {
  test("tag rename, custom attr rename, and media edits commit after their debounce", async () => {
    openDoc(
      {
        $media: {
          "--": "320px",
          "--desktop": "(min-width: 1200px)",
          "--tablet": "(min-width: 768px)",
        },
        attributes: { "data-keep": "old", "data-x": "1" },
        children: [],
        tagName: "div",
      },
      [],
    );
    const c = await renderPanel();

    // Tag rename (400ms via debouncedStyleCommit)
    const tag = c.querySelector('[data-prop="tagName"] sp-textfield') as HTMLInputElement;
    tag.value = "section";
    tag.dispatchEvent(new Event("input", { bubbles: true }));

    // Custom attribute rename + value (400ms kvRow debounce)
    const kvRows = [...section(c, "Custom")!.querySelectorAll(".kv-row")] as HTMLElement[];
    const xRow = kvRows.find((r) => (r.querySelector(".kv-key") as any).value === "data-x")!;
    const kvKey = xRow.querySelector(".kv-key") as HTMLInputElement;
    kvKey.value = "data-y";
    kvKey.dispatchEvent(new Event("input", { bubbles: true }));
    const kvVal = xRow.querySelector(".kv-val") as HTMLInputElement;
    kvVal.value = "2";
    kvVal.dispatchEvent(new Event("input", { bubbles: true }));

    // Same-key value-only edit on data-keep (else branch of the kvRow commit)
    const keepRow = kvRows.find((r) => (r.querySelector(".kv-key") as any).value === "data-keep")!;
    const keepVal = keepRow.querySelector(".kv-val") as HTMLInputElement;
    keepVal.value = "new";
    keepVal.dispatchEvent(new Event("input", { bubbles: true }));

    // Base width (400ms)
    const media = section(c, "Media")!;
    const base = media.querySelector(".kv-row input.field-input") as HTMLInputElement;
    base.value = "375px";
    base.dispatchEvent(new Event("input", { bubbles: true }));

    // Breakpoint query edit on --desktop (400ms)
    const queryInputs = [...media.querySelectorAll(".bp-query-input")] as HTMLInputElement[];
    const desktopQuery = queryInputs.find((q) => q.value.includes("1200"))!;
    desktopQuery.value = "(min-width: 1440px)";
    desktopQuery.dispatchEvent(new Event("input", { bubbles: true }));

    // Breakpoint rename Tablet → Phablet (600ms); raw label updates synchronously
    const rawLabels = [...media.querySelectorAll(".bp-raw-label")];
    const tabletRow = rawLabels.find((l) => l.textContent === "--tablet")!.parentElement!;
    const nameInput = tabletRow.querySelector("input.field-input") as HTMLInputElement;
    nameInput.value = "Phablet";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(tabletRow.querySelector(".bp-raw-label")!.textContent).toBe("--phablet");

    await sleep(700);

    const doc = docNow() as any;
    expect(doc.tagName).toBe("section");
    expect(doc.attributes["data-x"]).toBeUndefined();
    expect(doc.attributes["data-y"]).toBe("2");
    expect(doc.attributes["data-keep"]).toBe("new");
    expect(doc.$media["--"]).toBe("375px");
    expect(doc.$media["--desktop"]).toBe("(min-width: 1440px)");
    expect(doc.$media["--tablet"]).toBeUndefined();
    expect(doc.$media["--phablet"]).toBe("(min-width: 768px)");
  });

  test("switch case rename commits after its 500ms debounce", async () => {
    openDoc(switchDoc(), ["children", 0, "map"]);
    const c = await renderPanel();
    const input = section(c, "Switch")!.querySelector("input.field-input") as HTMLInputElement;
    input.value = "gamma";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(560);
    expect(Object.keys((docNow().children as any[])[0].map.cases)).toEqual(["beta", "gamma"]);
  });

  test("number prop commits after the number-field debounce", async () => {
    registerCard();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    const num = section(c, "Component Props")!.querySelector(
      '[data-prop="count"] sp-number-field',
    ) as HTMLInputElement;
    num.value = "5";
    num.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(460);
    expect((docNow().children as JxMutableNode[])[0]!.$props!.count).toBe("5");
  });
});
