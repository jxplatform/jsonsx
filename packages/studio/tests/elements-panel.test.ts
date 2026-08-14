/**
 * Elements panel — renderElementsTemplate: category accordion, search filter, element insertion,
 * and the component registry section (npm enablement via $elements + insertion with $props).
 */
import {
  installMockPlatform,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderElementsTemplate } from "../src/panels/elements-panel";
import { componentRegistry, loadComponentRegistry } from "../src/files/components";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { view } from "../src/view";
import type { ComponentEntry } from "../src/files/components";
import type { StudioPlatform } from "../src/types";
import type { JxMutableNode } from "@jxsuite/schema/types";

const WEBDATA = {
  elements: {
    Media: [{ tag: "img" }],
    Text: [{ tag: "h1" }, { tag: "p" }],
  },
};

function defaultDef(tag: string): JxMutableNode {
  return { tagName: tag, textContent: `New ${tag}` };
}

let host: HTMLElement;

async function renderElements(rerender: () => void = () => {}) {
  const tpl = renderElementsTemplate({ defaultDef, rerender, webdata: WEBDATA });
  await renderInto(tpl, host);
  return host;
}

async function seedRegistry(entries: ComponentEntry[]) {
  installMockPlatform({
    discoverComponents: (async () => entries) as StudioPlatform["discoverComponents"],
  });
  await loadComponentRegistry();
}

beforeEach(async () => {
  document.body.innerHTML = `<div id="host"></div>`;
  host = document.querySelector("#host") as HTMLElement;
  view.elementsFilter = "";
  view.elementsCollapsed = new Set();
  resetStudioState();
  resetWorkspaceWithTab({ children: [], tagName: "div" });
  await seedRegistry([]);
});

afterEach(() => {
  closeAllTabs();
  document.body.innerHTML = "";
});

describe("renderElementsTemplate — categories and filter", () => {
  test("renders one accordion item per category with element cards", async () => {
    await renderElements();
    const items = host.querySelectorAll("sp-accordion-item");
    expect(items.length).toBe(2);
    expect([...items].map((i) => i.getAttribute("label"))).toEqual(["Media", "Text"]);
    const tags = [...host.querySelectorAll(".element-card")].map(
      (c) => (c as HTMLElement).dataset.blockTag,
    );
    expect(tags).toEqual(["img", "h1", "p"]);
  });

  test("filter hides non-matching elements and empty categories", async () => {
    view.elementsFilter = "h1";
    await renderElements();
    const items = host.querySelectorAll("sp-accordion-item");
    expect(items.length).toBe(1);
    expect(items[0]!.getAttribute("label")).toBe("Text");
    expect(host.querySelectorAll(".element-card").length).toBe(1);
  });

  test("search input updates filter and rerenders", async () => {
    const rerender = mock(() => {});
    await renderElements(rerender);
    const search = host.querySelector("sp-search") as HTMLInputElement;
    (search as unknown as { value: string }).value = "IMG";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.elementsFilter).toBe("img");
    expect(rerender).toHaveBeenCalledTimes(1);
  });

  test("collapsed category renders accordion item closed", async () => {
    view.elementsCollapsed.add("Text");
    await renderElements();
    const text = [...host.querySelectorAll("sp-accordion-item")].find(
      (i) => i.getAttribute("label") === "Text",
    )!;
    expect(text.hasAttribute("open")).toBe(false);
    const media = [...host.querySelectorAll("sp-accordion-item")].find(
      (i) => i.getAttribute("label") === "Media",
    )!;
    expect(media.hasAttribute("open")).toBe(true);
  });

  test("accordion toggle event updates elementsCollapsed both ways", async () => {
    await renderElements();
    const item = host.querySelector("sp-accordion-item") as HTMLElement & { open: boolean };
    item.open = false;
    item.dispatchEvent(new CustomEvent("sp-accordion-item-toggle", { bubbles: true }));
    expect(view.elementsCollapsed.has("Media")).toBe(true);
    item.open = true;
    item.dispatchEvent(new CustomEvent("sp-accordion-item-toggle", { bubbles: true }));
    expect(view.elementsCollapsed.has("Media")).toBe(false);
  });
});

describe("renderElementsTemplate — element insertion", () => {
  test("clicking a card inserts the default def at the selection", async () => {
    await renderElements();
    const card = host.querySelector('[data-block-tag="h1"]') as HTMLElement;
    card.click();
    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children.length).toBe(1);
    expect(children[0]).toEqual({ tagName: "h1", textContent: "New h1" });
  });

  test("inserts into the selected parent node", async () => {
    resetWorkspaceWithTab({
      children: [{ children: [{ tagName: "p", textContent: "x" }], tagName: "section" }],
      tagName: "div",
    });
    activeTab.value!.session.selection = [["children", 0]];
    await renderElements();
    (host.querySelector('[data-block-tag="img"]') as HTMLElement).click();
    const section = (activeTab.value!.doc.document.children as JxMutableNode[])[0]!;
    const kids = section.children as JxMutableNode[];
    expect(kids.length).toBe(2);
    expect(kids[1]!.tagName).toBe("img");
  });
});

describe("renderElementsTemplate — components section", () => {
  const projectComp: ComponentEntry = {
    path: "components/my-card.json",
    props: [{ name: "title" }],
    source: "project",
    tagName: "my-card",
  } as ComponentEntry;
  const npmModuleComp: ComponentEntry = {
    modulePath: "dist/fancy-button.js",
    package: "@acme/widgets",
    props: [{ default: "go", name: "label" }],
    source: "npm",
    tagName: "fancy-button",
  } as ComponentEntry;
  const npmPkgComp: ComponentEntry = {
    package: "@acme/extras",
    props: [],
    source: "npm",
    tagName: "extra-thing",
  } as ComponentEntry;

  test("no components section when registry is empty", async () => {
    await renderElements();
    expect(host.querySelector(".components-section")).toBeNull();
  });

  test("npm components hidden unless enabled via $elements", async () => {
    await seedRegistry([projectComp, npmModuleComp, npmPkgComp]);
    await renderElements();
    const tags = [...host.querySelectorAll("[data-component-tag]")].map(
      (c) => (c as HTMLElement).dataset.componentTag,
    );
    expect(tags).toEqual(["my-card"]);
  });

  test("$elements entry matching package/modulePath enables that npm component", async () => {
    await seedRegistry([projectComp, npmModuleComp, npmPkgComp]);
    resetWorkspaceWithTab({
      $elements: ["@acme/widgets/dist/fancy-button.js"],
      children: [],
      tagName: "div",
    } as unknown as JxMutableNode);
    await renderElements();
    const tags = [...host.querySelectorAll("[data-component-tag]")].map(
      (c) => (c as HTMLElement).dataset.componentTag,
    );
    expect(tags).toContain("fancy-button");
    expect(tags).not.toContain("extra-thing");
    // Npm component title shows package: <tag>
    const card = host.querySelector('[data-component-tag="fancy-button"]') as HTMLElement;
    expect(card.getAttribute("title")).toBe("@acme/widgets: <fancy-button>");
  });

  test("bare package $elements entry enables all components from that package", async () => {
    await seedRegistry([npmPkgComp, npmModuleComp]);
    resetWorkspaceWithTab({
      $elements: ["@acme/extras"],
      children: [],
      tagName: "div",
    } as unknown as JxMutableNode);
    await renderElements();
    const tags = [...host.querySelectorAll("[data-component-tag]")].map(
      (c) => (c as HTMLElement).dataset.componentTag,
    );
    expect(tags).toEqual(["extra-thing"]);
  });

  test("filter applies to component tag names", async () => {
    await seedRegistry([projectComp]);
    view.elementsFilter = "zzz";
    await renderElements();
    expect(host.querySelector(".components-section")).toBeNull();
    view.elementsFilter = "card";
    await renderElements();
    expect(host.querySelector('[data-component-tag="my-card"]')).not.toBeNull();
  });

  test("clicking a component card inserts an instance with $props defaults", async () => {
    await seedRegistry([npmModuleComp]);
    resetWorkspaceWithTab({
      $elements: ["@acme/widgets/dist/fancy-button.js"],
      children: [],
      tagName: "div",
    } as unknown as JxMutableNode);
    await renderElements();
    (host.querySelector('[data-component-tag="fancy-button"]') as HTMLElement).click();
    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children.length).toBe(1);
    expect(children[0]).toEqual({ $props: { label: "go" }, tagName: "fancy-button" });
  });

  test("component props without defaults become empty strings", async () => {
    await seedRegistry([projectComp]);
    await renderElements();
    (host.querySelector('[data-component-tag="my-card"]') as HTMLElement).click();
    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children[0]).toEqual({ $props: { title: "" }, tagName: "my-card" });
  });

  test("components accordion toggle updates elementsCollapsed", async () => {
    await seedRegistry([projectComp]);
    await renderElements();
    expect(componentRegistry.length).toBe(1);
    const item = [...host.querySelectorAll("sp-accordion-item")].find(
      (i) => i.getAttribute("label") === "Components",
    ) as HTMLElement & { open: boolean };
    expect(item).toBeDefined();
    item.open = false;
    item.dispatchEvent(new CustomEvent("sp-accordion-item-toggle", { bubbles: true }));
    expect(view.elementsCollapsed.has("Components")).toBe(true);
    item.open = true;
    item.dispatchEvent(new CustomEvent("sp-accordion-item-toggle", { bubbles: true }));
    expect(view.elementsCollapsed.has("Components")).toBe(false);
  });
});

describe("renderElementsTemplate — empty states", () => {
  test("a filter that matches nothing says so and offers to clear itself", async () => {
    let rerenders = 0;
    view.elementsFilter = "zzz";
    await renderElements(() => {
      rerenders += 1;
    });
    expect(host.querySelector(".empty-state-message")?.textContent).toBe(
      "Nothing here matches \u201Czzz\u201D.",
    );
    (host.querySelector(".empty-state-action") as HTMLElement).click();
    expect(view.elementsFilter).toBe("");
    expect(rerenders).toBe(1);
  });

  test("an empty palette teaches what the region is for, with no action to offer", async () => {
    const tpl = renderElementsTemplate({
      defaultDef,
      rerender: () => {},
      webdata: { elements: {} },
    });
    await renderInto(tpl, host);
    expect(host.querySelector(".empty-state-message")?.textContent).toContain(
      "Elements you can drop onto the page live here",
    );
    expect(host.querySelector(".empty-state-action")).toBeNull();
  });
});
