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
import { capsForPosition } from "../src/ui/value-source";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  invalidatePageRouteCache,
  renderPropertiesPanelTemplate,
} from "../src/panels/properties-panel";
import { componentRegistry } from "../src/files/components";
import { resetSlotModeMemory } from "../src/ui/dynamic-slot";
import { view } from "../src/view";
import { shell } from "../src/shell";
import { setActiveRegistry } from "../src/commands/active-registry";
import type { CommandRegistry } from "../src/commands/registry";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  activeTab,
  closeAllTabs,
  focusPane,
  workspace,
} from "../src/workspace/workspace";
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

  test("Open Layout → runs ONE command and does not clear the layout selection", async () => {
    /* Four assertions INVERTED, and each inversion is the point of the change.
       `openLayoutAtNode` used to navigate, `setLayoutSelection(null)`, re-select against
       `activeTab` and `renderOnly("rightPanel")`. It opened the layout OVER the page it was
       teaching about, and clearing the selection is precisely what killed the follow on its first
       frame — `shell.layoutSelection` is what the layout companion follows the NODE through. The
       chip is a control now: it runs `pane.derive { preset: "layout" }` and decides nothing. */
    openDoc({ children: [], tagName: "div" });
    shell.layoutSelection = headerHit;
    const ran: { id: string; args: unknown }[] = [];
    setActiveRegistry({
      run: (id: string, args: unknown) => {
        ran.push({ args, id });
        return Promise.resolve();
      },
    } as unknown as CommandRegistry);

    const c = await renderPanel();
    pointer(kvAdd(c, "Open Layout")!, "click");
    await flush();

    expect(ran).toEqual([{ args: { preset: "layout" }, id: "pane.derive" }]);
    // No `navigate` call of its own — the chip does not know what opening a layout means.
    expect(navCalls).toEqual([]);
    // And the layout selection SURVIVES: it is the node the following pane keeps highlighting.
    expect(shell.layoutSelection).toEqual(headerHit);
    setActiveRegistry(null);
  });

  /* FINDING 8. `canvas/iframe-host.ts`'s `layoutHit` handler calls `focusHostPane(state)`, which
     moves the keyboard into the pane the click landed in — including a LENS, which draws layout
     chrome because it draws the same document. From there `pane.derive` can only refuse: its
     enablement is `deriveRefusal(activePane().id)`, and a derived pane cannot derive again. The
     chip was drawn anyway and its handler is `void activeRegistry()?.run(…)`, so the throw went
     into a `void` and the author pressed a control that did nothing at all.

       chip drawn in a lens-focused shell = true
       THREW CommandUnavailableError … requires an open document in a pane that is not itself
       derived */
  test("Open Layout → is not drawn in a shell whose focused pane is itself derived", async () => {
    openDoc({ children: [], tagName: "div" });
    shell.layoutSelection = headerHit;
    expect(kvAdd(await renderPanel(), "Open Layout")).not.toBeNull();

    // A lens beside the page, with the keyboard in it — which is where a click on layout chrome
    // Drawn by that lens leaves it.
    workspace.panes.push({ activeTabId: null, derived: null, id: SECONDARY_PANE, tabOrder: [] });
    workspace.panes[1]!.derived = {
      diff: null,
      kind: "lens",
      media: null,
      mode: "design",
      preset: "breakpoint",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
    };
    focusPane(SECONDARY_PANE);

    const c = await renderPanel();
    /* By LABEL rather than by element: `expect(<happy-dom element>).toBeUndefined()` prints the
       element, and a happy-dom element's inspection reaches its `window` — sixty thousand lines of
       class table for one wrong chip, which is what a reviewer would have to read past. */
    expect([...c.querySelectorAll(".kv-add")].map((el) => el.textContent?.trim())).not.toContain(
      "Open Layout →",
    );
    // The sentence explaining where the element comes from stays — that is the panel's job, and it
    // Is true wherever the keyboard is.
    expect(c.textContent).toContain("layouts/base.json");
    focusPane(PRIMARY_PANE);
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

describe("the Tag row is a bindable slot like any other", () => {
  /*
   * `tagName` may be a literal name or a `TagExpression` choosing between names. It was one
   * hardcoded textfield, which for a choice rendered `[object Object]` and let the first keystroke
   * replace the whole expression with whatever was typed. It is now the shared Value Source slot —
   * the same chip and the same expression editor as `href`, a style declaration or a handler.
   */
  const chosen = {
    $expression: {
      initial: "div",
      operator: "?:" as const,
      target: { $ref: "#/state/href" },
      value: "a",
    },
  };
  const tagRow = (c: HTMLElement) => c.querySelector('[data-prop="tagName"]')!;

  test("a fixed tag shows Fixed value and a typeable field", async () => {
    openDoc({ children: [{ children: [], tagName: "section" }], tagName: "x-card" }, [
      "children",
      0,
    ]);
    const row = tagRow(await renderPanel());
    expect(row.querySelector(".dynamic-slot-mode")!.textContent!.trim()).toBe("Fixed value");
    expect((row.querySelector("sp-textfield") as unknown as { value: string }).value).toBe(
      "section",
    );
  });

  test("a chosen tag shows Formula, and never renders the object into a field", async () => {
    openDoc({ children: [{ children: [], tagName: chosen }], tagName: "x-card" }, ["children", 0]);
    const row = tagRow(await renderPanel());
    expect(row.querySelector(".dynamic-slot-mode")!.textContent!.trim()).toBe("Formula");
    expect(row.textContent).not.toContain("[object Object]");
  });

  test("the rungs are the two the schema permits — no template rung", async () => {
    // Derived from `SLOT_POSITION_SCHEMAS.elementTag`, not hand-listed. A `${…}` in tag position is
    // What the `TagName` pattern exists to reject, so the rung is correctly absent.
    expect(capsForPosition("elementTag")).toEqual(["literal", "expression"]);
  });
});

describe("editing a component definition is not editing an instance of it", () => {
  /*
   * A component's own root tag has a hyphen, so the old test — "the tag contains a dash" — said
   * yes to both. Open the component itself and the panel drew the INSTANCE form over the
   * definition: fields writing `$props` onto the definition's own root, and a "from the component"
   * badge whose click opened the document already in front of you.
   *
   * The distinguishing fact is whose document this is.
   */
  function openAs(documentPath: string) {
    componentRegistry.length = 0;
    componentRegistry.push({
      path: "components/my-card.json",
      props: [{ default: "Untitled", name: "title", type: "string" }],
      source: "project",
      tagName: "my-card",
    } as never);
    const tab = resetWorkspaceWithTab({
      children: [],
      state: { title: { default: "Untitled", type: "string" } },
      tagName: "my-card",
    } as never);
    tab.documentPath = documentPath;
    tab.session.selection = [[]] as never;
    return tab;
  }

  test("the definition shows DEFAULTS, and offers no jump to itself", async () => {
    openAs("components/my-card.json");
    const c = await renderPanel();
    expect(section(c, "Component Defaults")).not.toBeNull();
    expect(section(c, "Component Settings")).toBeNull();
    // "→ Edit definition" from inside the definition is a link to here.
    expect(c.textContent).not.toContain("Edit definition");
    // …and the donor badge cannot say "from the component" when it IS the component.
    expect(c.textContent).not.toContain("the component default");
  });

  test("an instance keeps the settings form, the donor and the jump", async () => {
    componentRegistry.length = 0;
    componentRegistry.push({
      path: "components/my-card.json",
      props: [{ default: "Untitled", name: "title", type: "string" }],
      source: "project",
      tagName: "my-card",
    } as never);
    const tab = resetWorkspaceWithTab({
      children: [{ children: [], tagName: "my-card" }],
      tagName: "div",
    } as never);
    tab.documentPath = "pages/index.json";
    tab.session.selection = [["children", 0]] as never;
    const c = await renderPanel();
    expect(section(c, "Component Settings")).not.toBeNull();
    expect(section(c, "Component Defaults")).toBeNull();
    expect(c.textContent).toContain("Edit definition");
  });

  test("a default typed in the definition lands on the state entry, not on $props", async () => {
    const tab = openAs("components/my-card.json");
    const c = await renderPanel();
    const field = section(c, "Component Defaults")!.querySelector(
      "sp-textfield",
    ) as HTMLInputElement;
    field.value = "A card";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => {
      setTimeout(r, 450);
    });
    const doc = tab.doc.document as JxMutableNode & {
      state?: Record<string, { default?: unknown }>;
      $props?: Record<string, unknown>;
    };
    expect(doc.state?.title?.default).toBe("A card");
    expect(doc.$props).toBeUndefined();
  });
});
