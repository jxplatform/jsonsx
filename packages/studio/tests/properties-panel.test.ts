/**
 * Tests for src/panels/properties-panel.ts — the Content tab: the element itself, its HTML
 * attributes, its link target, its custom attributes and its component props.
 *
 * Repeater, Switch and the custom-element contract sections moved to the Logic tab in P5
 * (`tests/events-panel.test.ts`); the Page section moved to the Document Header card
 * (`tests/head-panel.test.ts`). What is tested here is what Content still draws.
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
  invalidatePageRouteCache,
  renderPropertiesPanelTemplate,
} from "../src/panels/properties-panel";
import { componentRegistry } from "../src/files/components";
import { resetSlotModeMemory } from "../src/ui/dynamic-slot";
import { view } from "../src/view";
import { shell } from "../src/shell";
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
  tab.session.selection = selection ? [selection] : [];
  return tab;
}

function docNow(): JxMutableNode {
  return activeTab.value!.doc.document as JxMutableNode;
}

function section(root: Element, label: string): HTMLElement | null {
  return root.querySelector(`sp-accordion-item[label="${label}"]`);
}

function kvAdd(root: Element, text: string): HTMLElement | undefined {
  return [...root.querySelectorAll(".kv-add")].find((el) => el.textContent?.includes(text)) as
    | HTMLElement
    | undefined;
}

/**
 * Pick a rung on a row's Value Source control (§6.3's ladder, `ui/dynamic-slot.ts`).
 *
 * The chip opens a picker rather than cycling, so a test names the rung it wants instead of
 * counting clicks — which is the behaviour change that made "$ref → literal must pass through ${}"
 * untrue.
 */
function chooseValueSource(row: Element, mode: "literal" | "ref" | "template" | "expression") {
  pointer(row.querySelector(`sp-menu-item[data-mode="${mode}"]`)!, "click");
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(() => {
  navCalls.length = 0;
  shell.layoutSelection = null;
  view.showAddBreakpointForm = false;
  view.addBreakpointPreview = "";
  componentRegistry.length = 0;
  invalidatePageRouteCache();
  resetSlotModeMemory();
  resetStudioState();
  installMockPlatform();
});

// ─── Empty states ─────────────────────────────────────────────────────────────

describe("empty states", () => {
  test("no tab open → teaches what the inspector needs, with the action that supplies it", async () => {
    closeAllTabs();
    const c = await renderPanel();
    expect(c.textContent).toContain("Open a page to inspect and style what you click.");
    expect((c.querySelector(".empty-state-action") as HTMLElement).textContent?.trim()).toBe(
      "Open a page…",
    );
  });

  test("tab open without selection → the one shared canvas verb", async () => {
    openDoc({ children: [], tagName: "div" }, null);
    const c = await renderPanel();
    expect(c.textContent).toContain("Click anything on the canvas to edit its content.");
  });

  test("selection pointing at a missing node → says it is gone, then repeats the verb", async () => {
    openDoc({ children: [{ tagName: "p" }], tagName: "div" }, ["children", 9, "children", 0]);
    const c = await renderPanel();
    expect(c.textContent).toContain("no longer on the page");
    expect(c.textContent).toContain("Click anything on the canvas");
  });
});

// ─── Layout selection panel ───────────────────────────────────────────────────

describe("layout selection panel", () => {
  const headerHit = {
    className: "site-header",
    layoutFile: "layouts/base.json",
    layoutPath: ["children", 0, "children", 0],
    rect: { height: 40, width: 800, x: 0, y: 0 },
    tagName: "header",
  };

  test("shows tag, class, and the layout file the element came from", async () => {
    openDoc({ children: [], tagName: "div" });
    shell.layoutSelection = headerHit;

    const c = await renderPanel();
    expect(section(c, "Layout Element")).not.toBeNull();
    expect(c.textContent).toContain("header");
    expect(c.textContent).toContain("site-header");
    expect(c.textContent).toContain("layouts/base.json");
  });

  test("a layout selection wins over the document selection (a layout node is not in this doc)", async () => {
    openDoc({ children: [{ tagName: "p" }], tagName: "div" }, ["children", 0]);
    shell.layoutSelection = headerHit;
    const c = await renderPanel();
    expect(section(c, "Layout Element")).not.toBeNull();
  });

  test("Open Layout → opens the file AND selects the clicked node in it, then releases", async () => {
    const tab = openDoc({ children: [], tagName: "div" });
    shell.layoutSelection = headerHit;
    // Stand in for studio.ts's navigateToComponent: it swaps the tab's document in place.
    const navigate = async (path: string) => {
      await Promise.resolve();
      navCalls.push(path);
      tab.documentPath = path;
      tab.session.selection = [];
    };
    const c = await renderInto(renderPropertiesPanelTemplate({ navigateToComponent: navigate }));

    pointer(kvAdd(c, "Open Layout")!, "click");
    await flush();

    expect(navCalls).toEqual(["layouts/base.json"]);
    expect(tab.session.selection).toEqual([["children", 0, "children", 0]]);
    // The layout is now the OPEN document, so its nodes are ordinary content again.
    expect(shell.layoutSelection).toBeNull();
  });

  test("navigating somewhere other than the layout leaves the selection alone", async () => {
    const tab = openDoc({ children: [], tagName: "div" });
    shell.layoutSelection = headerHit;
    const navigate = async () => {
      await Promise.resolve();
      tab.documentPath = "components/other.json";
      tab.session.selection = [];
    };
    const c = await renderInto(renderPropertiesPanelTemplate({ navigateToComponent: navigate }));

    pointer(kvAdd(c, "Open Layout")!, "click");
    await flush();
    expect(tab.session.selection).toEqual([]);
  });

  test("falls back to generic labels when the hit names no tag, class, or file", async () => {
    openDoc({ children: [], tagName: "div" });
    shell.layoutSelection = {
      className: "",
      layoutFile: "",
      layoutPath: [],
      rect: { height: 0, width: 0, x: 0, y: 0 },
      tagName: "",
    };

    const c = await renderPanel();
    expect(c.textContent).toContain("element");
    // No class row rendered
    expect([...c.querySelectorAll("sp-field-label")].map((l) => l.textContent)).not.toContain(
      "Class",
    );
    pointer(kvAdd(c, "Open Layout")!, "click");
    await flush();
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
    pointer(c.querySelector('[title="Clear ID"]')!, "click");
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
    expect(section(c, "Component Settings")!.textContent).toContain("not in the project's library");
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
    expect(section(c, "Component Settings")!.textContent).toContain(
      "This component has no settings to fill in yet.",
    );
  });

  test("renders one widget per prop with the right control types", async () => {
    registerCard();
    openDoc(cardDoc({ title: "Hi" }), ["children", 0]);
    const c = await renderPanel();
    const sec = section(c, "Component Settings")!;
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
    const sec = section(c, "Component Settings")!;
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
    let box = section(c, "Component Settings")!.querySelector(
      '[data-prop="featured"] sp-checkbox',
    ) as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props).toBeUndefined();

    c = await renderPanel();
    box = section(c, "Component Settings")!.querySelector(
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
    const sel = section(c, "Component Settings")!.querySelector(
      '[data-prop="variant"] jx-value-selector',
    )!;
    sel.dispatchEvent(new CustomEvent("change", { bubbles: true, detail: { value: "fancy" } }));
    expect((docNow().children as JxMutableNode[])[0]!.$props!.variant).toBe("fancy");
  });

  test("date prop commits via its text field", async () => {
    registerCard();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    const field = section(c, "Component Settings")!.querySelector(
      '[data-prop="published"] sp-textfield',
    ) as HTMLInputElement;
    field.value = "2026-06-12";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props!.published).toBe("2026-06-12");
  });

  test("the value source picker moves a prop between rungs and remembers the literal", async () => {
    registerCard();
    openDoc(cardDoc({ title: "Hi" }), ["children", 0]);
    let c = await renderPanel();
    const titleRow = () =>
      section(c, "Component Settings")!.querySelector('[data-prop="title"]') as HTMLElement;
    chooseValueSource(titleRow(), "ref");
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toEqual({
      $ref: "#/state/username",
    });

    c = await renderPanel();
    expect(titleRow().querySelector(".dynamic-slot-mode")!.textContent!.trim()).toBe("From data…");
    chooseValueSource(titleRow(), "template");
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toBe("${state.username}");

    c = await renderPanel();
    chooseValueSource(titleRow(), "literal");
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toBe("Hi");
  });

  test("a prop opened already-bound drops to the signal's declared default", async () => {
    registerCard();
    openDoc(cardDoc({ title: { $ref: "#/state/username" } }), ["children", 0]);
    const c = await renderPanel();
    const titleRow = section(c, "Component Settings")!.querySelector(
      '[data-prop="title"]',
    ) as HTMLElement;
    chooseValueSource(titleRow, "literal");
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toBe("kevin");
  });

  test("bound prop renders a signal picker that rebinds or clears", async () => {
    registerCard();
    openDoc(cardDoc({ title: { $ref: "#/state/username" } }), ["children", 0]);
    let c = await renderPanel();
    let picker = section(c, "Component Settings")!.querySelector(
      '[data-prop="title"] sp-picker',
    ) as HTMLInputElement;
    expect(picker).not.toBeNull();
    picker.value = "#/state/username";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.$props!.title).toEqual({
      $ref: "#/state/username",
    });

    c = await renderPanel();
    picker = section(c, "Component Settings")!.querySelector(
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
    let field = section(c, "Component Settings")!.querySelector(
      '[data-prop="label"] sp-textfield',
    ) as HTMLInputElement;
    field.value = "Click me";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.label).toBe("Click me");

    // Empty value removes the attribute
    c = await renderPanel();
    field = section(c, "Component Settings")!.querySelector(
      '[data-prop="label"] sp-textfield',
    ) as HTMLInputElement;
    field.value = "";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes?.label).toBeUndefined();

    // Npm comp without a path → no Edit definition link
    c = await renderPanel();
    expect(kvAdd(section(c, "Component Settings")!, "Edit definition")).toBeUndefined();
  });

  test("npm prop cycled to ref stores a real $ref object in attributes", async () => {
    componentRegistry.push({
      props: [{ name: "label", type: "string" }],
      source: "npm",
      tagName: "sl-button",
    } as never);
    openDoc(
      {
        children: [{ attributes: { label: "Hi" }, tagName: "sl-button" }],
        state: { username: { default: "kevin" } },
        tagName: "div",
      },
      ["children", 0],
    );
    const c = await renderPanel();
    chooseValueSource(
      section(c, "Component Settings")!.querySelector('[data-prop="label"]')!,
      "ref",
    );
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.label).toEqual({
      $ref: "#/state/username",
    });
  });

  test("inside a map template, props bind to $map signals when no state defs exist", async () => {
    registerCard();
    openDoc(
      { children: { $prototype: "Array", items: [], map: { tagName: "my-card" } }, tagName: "div" },
      ["children", 0, "map"],
    );
    let c = await renderPanel();
    let row = section(c, "Component Settings")!.querySelector('[data-prop="title"]')!;
    chooseValueSource(row, "ref");
    expect((docNow().children as any[])[0].map.$props.title).toEqual({ $ref: "$map/item" });

    c = await renderPanel();
    row = section(c, "Component Settings")!.querySelector('[data-prop="title"]')!;
    const refPicker = row.querySelector("sp-picker")!;
    const opts = [...refPicker.querySelectorAll("sp-menu-item")].map((m) =>
      m.getAttribute("value"),
    );
    expect(opts).toEqual(["$map/item", "$map/index"]);
    expect(refPicker.querySelector("sp-menu-divider")).not.toBeNull();
  });

  test("Edit definition link navigates to the component file", async () => {
    registerCard();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    pointer(kvAdd(section(c, "Component Settings")!, "Edit definition")!, "click");
    expect(navCalls).toEqual(["components/my-card.json"]);
  });
});

// ─── The tab re-split (§6.5) ──────────────────────────────────────────────────

describe("what Content no longer draws", () => {
  test("a repeating list says where its wiring lives and offers the tab that has it", async () => {
    openDoc(
      {
        children: { $prototype: "Array", items: [], map: { tagName: "li" } },
        tagName: "ul",
      },
      ["children", 0],
    );
    const c = await renderPanel();
    expect(c.textContent).toContain("A repeating list has no content of its own.");
    expect(c.textContent).toContain("live in Logic");
    expect((c.querySelector(".empty-state-action") as HTMLElement).textContent?.trim()).toBe(
      "Open Logic",
    );
    // And it draws none of the sections it used to.
    expect(section(c, "Repeating list")).toBeNull();
    expect(section(c, "Element")).toBeNull();
  });

  test("the Open Logic button actually selects the Logic tab", async () => {
    const tab = openDoc(
      { children: { $prototype: "Array", items: [], map: { tagName: "li" } }, tagName: "ul" },
      ["children", 0],
    );
    const c = await renderPanel();
    pointer(c.querySelector(".empty-state-action")!, "click");
    // The dock is reached through a lazy import (Content must not statically depend on its host),
    // So the tab lands a few turns later.
    for (let i = 0; i < 20 && tab.session.ui.rightTab !== "events"; i++) {
      await flush(1);
    }
    expect(tab.session.ui.rightTab).toBe("events");
  });

  test("a $switch node keeps its Content rows and grows no Condition section", async () => {
    openDoc({ children: [{ $switch: "${x}", cases: {}, tagName: "li" }], tagName: "ul" }, [
      "children",
      0,
    ]);
    const c = await renderPanel();
    expect(section(c, "Condition")).toBeNull();
    expect(section(c, "Element")).not.toBeNull();
  });

  test("a custom-element root keeps Content rows and loses the outward-contract sections", async () => {
    openDoc(
      {
        attributes: { part: "root" },
        state: { label: { attribute: "label", default: "x" } },
        style: { "--accent": "red" },
        tagName: "my-widget",
      },
      [],
    );
    const c = await renderPanel();
    expect(section(c, "Observed Attributes")).toBeNull();
    expect(section(c, "CSS Properties")).toBeNull();
    expect(section(c, "CSS Parts")).toBeNull();
    expect(section(c, "Element")).not.toBeNull();
  });

  test("no Page section survives, on a site page or anywhere else", async () => {
    resetStudioState({
      isSiteProject: true,
      projectConfig: { defaults: { layout: "./layouts/base.json" } },
    });
    installMockPlatform();
    const tab = resetWorkspaceWithTab({ children: [], tagName: "div" } as never);
    tab.documentPath = "pages/index.json";
    tab.session.selection = [[]] as never;
    const c = await renderPanel();
    expect(section(c, "Page")).toBeNull();
    expect(c.querySelector('[data-prop="$layout"]')).toBeNull();
  });
});

// ─── Provenance chips on component props (§6.2) ───────────────────────────────

describe("component prop provenance", () => {
  function registerDefaulted() {
    componentRegistry.push({
      path: "components/my-card.json",
      props: [
        { default: "Untitled", name: "title", type: "string" },
        { name: "subtitle", type: "string" },
      ],
      source: "local",
      tagName: "my-card",
    } as never);
  }

  function chip(root: Element, prop: string): HTMLElement | null {
    return root.querySelector(`[data-prop="${prop}"] .provenance-chip`);
  }

  test("a value set on the instance is the accent dot, and clicking it clears", async () => {
    registerDefaulted();
    openDoc(cardDoc({ title: "Mine" }), ["children", 0]);
    const c = await renderPanel();
    const dot = chip(c, "title")!;
    expect(dot.classList.contains("provenance-chip--set")).toBe(true);
    expect(dot.classList.contains("set-dot")).toBe(true);
    pointer(dot, "click");
    expect((docNow().children as JxMutableNode[])[0]!.$props).toBeUndefined();
  });

  test("an unset prop with a component default names the donor and jumps to it", async () => {
    registerDefaulted();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    const inherited = chip(c, "title")!;
    expect(inherited.classList.contains("provenance-chip--inherited")).toBe(true);
    expect(inherited.textContent!.trim()).toBe("from the component default");
    expect(inherited.getAttribute("title")).toContain("Untitled");
    pointer(inherited, "click");
    expect(navCalls).toEqual(["components/my-card.json"]);
  });

  test("an unset prop with NO component default draws no chip at all", async () => {
    registerDefaulted();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    expect(chip(c, "subtitle")).toBeNull();
  });

  test("a bound prop is violet and names the signal, not the pointer", async () => {
    registerDefaulted();
    openDoc(cardDoc({ title: { $ref: "#/state/username" } }), ["children", 0]);
    const c = await renderPanel();
    const bound = chip(c, "title")!;
    expect(bound.classList.contains("provenance-chip--bound")).toBe(true);
    expect(bound.textContent!.trim()).toBe("username");
  });

  test("a $ref that points nowhere says so rather than naming an empty pointer", async () => {
    registerDefaulted();
    openDoc(cardDoc({ title: { $ref: "" } }), ["children", 0]);
    const c = await renderPanel();
    expect(chip(c, "title")!.textContent!.trim()).toBe("nothing yet");
  });

  test("dropping a prop bound to a def with no declared default just clears it", async () => {
    registerDefaulted();
    const tab = openDoc(cardDoc({ subtitle: { $ref: "#/state/username" } }), ["children", 0]);
    (tab.doc.document as unknown as Record<string, unknown>).state = { username: {} };
    const c = await renderPanel();
    chooseValueSource(
      section(c, "Component Settings")!.querySelector('[data-prop="subtitle"]')!,
      "literal",
    );
    expect((docNow().children as JxMutableNode[])[0]!.$props?.subtitle).toBeUndefined();
  });

  test("an expression-valued prop reads as bound to a formula", async () => {
    registerDefaulted();
    openDoc(cardDoc({ title: { $expression: { operator: "=", target: null } } }), ["children", 0]);
    const c = await renderPanel();
    expect(chip(c, "title")!.textContent!.trim()).toBe("a formula");
  });

  test("a template-valued prop reads as bound to a template", async () => {
    registerDefaulted();
    openDoc(cardDoc({ title: "${state.username}" }), ["children", 0]);
    const c = await renderPanel();
    expect(chip(c, "title")!.textContent!.trim()).toBe("a template");
  });

  test("a bound HTML attribute names its signal too", async () => {
    openDoc(
      {
        children: [{ attributes: { href: { $ref: "#/state/url" } }, tagName: "link" }],
        state: { url: { default: "/x" } },
        tagName: "div",
      },
      ["children", 0],
    );
    const c = await renderPanel();
    const bound = c.querySelector('[data-prop="href"] .provenance-chip')!;
    expect(bound.classList.contains("provenance-chip--bound")).toBe(true);
    expect(bound.textContent!.trim()).toBe("url");
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

  test("the section dot states a count and no longer pretends to be a control", async () => {
    openDoc(
      {
        children: [{ attributes: { href: "/x", target: "_blank" }, tagName: "a" }],
        tagName: "div",
      },
      ["children", 0],
    );
    const c = await renderPanel();
    const dot = section(c, "Link")!.querySelector(".set-dot--section")!;
    expect(dot.getAttribute("title")).toBe("2 values set in this section");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    // It was a <span class="set-dot"> with a pointer cursor, a danger hover and no handler at all.
    expect(dot.tagName.toLowerCase()).toBe("span");
  });

  test("a section with nothing set draws no dot", async () => {
    openDoc({ children: [{ tagName: "a" }], tagName: "div" }, ["children", 0]);
    const c = await renderPanel();
    expect(section(c, "Link")!.querySelector(".set-dot--section")).toBeNull();
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

  test("attribute rows carry a mode button beside the label", async () => {
    openDoc(linkDoc(), ["children", 0]);
    const c = await renderPanel();
    const mode = hrefRow(c).querySelector(".style-row-label .dynamic-slot-mode")!;
    expect(mode).not.toBeNull();
    expect(mode.textContent!.trim()).toBe("Fixed value");
    expect(mode.getAttribute("title")).toBe("Value source: Fixed value — click to change");
  });

  test("switching to ref mode binds the first signal; the picker rebinds", async () => {
    openDoc(linkDoc(), ["children", 0]);
    let c = await renderPanel();
    chooseValueSource(hrefRow(c), "ref");
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

  test("a bound attribute drops to a fixed value in ONE action", async () => {
    openDoc(linkDoc({ $ref: "#/state/url" }), ["children", 0]);
    const c = await renderPanel();
    chooseValueSource(hrefRow(c), "template");
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("${state.alt}");
  });

  test("leaving and re-entering Fixed value restores the attribute's former literal", async () => {
    openDoc(linkDoc(), ["children", 0]);
    let c = await renderPanel();
    chooseValueSource(hrefRow(c), "ref");
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toEqual({
      $ref: "#/state/alt",
    });

    c = await renderPanel();
    chooseValueSource(hrefRow(c), "literal");
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("/x");
  });

  test("template-valued attribute renders the template textfield and commits edits", async () => {
    openDoc(linkDoc("${state.url}/feed"), ["children", 0]);
    const c = await renderPanel();
    const mode = hrefRow(c).querySelector(".dynamic-slot-mode")!;
    expect(mode.textContent!.trim()).toBe("Mixed text");
    const tf = hrefRow(c).querySelector("sp-textfield") as HTMLInputElement;
    expect(tf.value).toBe("${state.url}/feed");
    tf.value = "${state.alt}/feed";
    tf.dispatchEvent(new Event("change", { bubbles: true }));
    expect((docNow().children as JxMutableNode[])[0]!.attributes!.href).toBe("${state.alt}/feed");
  });

  test("boolean attribute rows carry the mode button and bind via ref", async () => {
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
    expect(rowEl.querySelector(".dynamic-slot-mode")).not.toBeNull();
    chooseValueSource(rowEl, "ref");
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
    const textRow = c.querySelector('[data-prop="textContent"]')!;
    expect(textRow.querySelector(".dynamic-slot-mode")).not.toBeNull();
    chooseValueSource(textRow, "ref");
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
    tab.session.selection = [["children", 0]] as never;

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
    tab.session.selection = [["children", 0]] as never;
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
    tab.session.selection = [["children", 0]] as never;
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

// ─── Debounced edits (real timers, consolidated) ──────────────────────────────

describe("debounced edits", () => {
  test("tag rename and custom attr rename commit after their debounce", async () => {
    openDoc(
      {
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

    await sleep(700);

    const doc = docNow() as any;
    expect(doc.tagName).toBe("section");
    expect(doc.attributes["data-x"]).toBeUndefined();
    expect(doc.attributes["data-y"]).toBe("2");
    expect(doc.attributes["data-keep"]).toBe("new");
  });

  test("number prop commits after the number-field debounce", async () => {
    registerCard();
    openDoc(cardDoc(), ["children", 0]);
    const c = await renderPanel();
    const num = section(c, "Component Settings")!.querySelector(
      '[data-prop="count"] sp-number-field',
    ) as HTMLInputElement;
    num.value = "5";
    num.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(460);
    expect((docNow().children as JxMutableNode[])[0]!.$props!.count).toBe("5");
  });
});
