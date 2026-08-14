/**
 * Tab strip — disambiguated labels, the overflow chevron, and the drill-in relationship marker.
 *
 * The plain tab-strip behaviours (activation, dirty dot, close flow, wheel scrolling) live in
 * tab-strip.test.ts; this file covers what P2 added.
 */
import { flush } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  computeTabLabels,
  dismissOverflowMenu,
  hiddenTabIds,
  mount,
  pageRoute,
  tabLabel,
  unmount,
} from "../src/panels/tab-strip";
import { activePane, closeAllTabs, openTab, workspace } from "../src/workspace/workspace";
import { initLayers } from "../src/ui/layers";
import type { Tab } from "../src/tabs/tab";

let host: HTMLElement;

function open(id: string, documentPath: string | null = `pages/${id}.md`) {
  return openTab({ document: { children: [], tagName: "div" }, documentPath, id });
}

function labels(): string[] {
  return [...host.querySelectorAll(".tab-strip-label")].map((el) => el.textContent ?? "");
}

/** Happy-dom performs no layout; stub the two metrics the overflow check reads. */
function stubMetrics(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
}

function strip(): HTMLElement {
  return host.querySelector(".tab-strip") as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="tab-strip"></div>
    <div id="layer-popover"></div>
    <div id="layer-modal"></div>
    <div id="layer-dialog"></div>
  `;
  initLayers();
  host = document.querySelector("#tab-strip") as HTMLElement;
  closeAllTabs();
  mount(host);
});

afterEach(() => {
  dismissOverflowMenu();
  unmount();
  closeAllTabs();
  document.body.innerHTML = "";
});

describe("pageRoute", () => {
  test("derives the route a page is published at", () => {
    expect(pageRoute("pages/index.md")).toBe("/");
    expect(pageRoute("pages/about.md")).toBe("/about");
    expect(pageRoute("pages/about/index.md")).toBe("/about");
    expect(pageRoute("pages/blog/[slug].md")).toBe("/blog/[slug]");
    expect(pageRoute("./pages/blog/index.json")).toBe("/blog");
  });

  test("returns null for anything that is not under pages/", () => {
    expect(pageRoute("components/card.json")).toBeNull();
    expect(pageRoute("project.json")).toBeNull();
    expect(pageRoute("src/pages/index.md")).toBeNull();
  });
});

describe("computeTabLabels", () => {
  test("a page labels by route, so four index files read as four routes", () => {
    const result = computeTabLabels([
      { documentPath: "pages/index.md", fallback: "", id: "a" },
      { documentPath: "pages/blog/index.md", fallback: "", id: "b" },
      { documentPath: "pages/blog/[slug].md", fallback: "", id: "c" },
      { documentPath: "pages/shop/index.md", fallback: "", id: "d" },
    ]);
    expect([...result.values()]).toEqual(["/", "/blog", "/blog/[slug]", "/shop"]);
  });

  test("non-pages get the shortest suffix that tells them apart", () => {
    const result = computeTabLabels([
      { documentPath: "content/posts/index.json", fallback: "", id: "a" },
      { documentPath: "content/notes/index.json", fallback: "", id: "b" },
      { documentPath: "components/card.json", fallback: "", id: "c" },
    ]);
    expect(result.get("a")).toBe("posts/index.json");
    expect(result.get("b")).toBe("notes/index.json");
    // The uncontested tab keeps its basename — one collision does not widen the whole strip.
    expect(result.get("c")).toBe("card.json");
  });

  test("widening continues until the suffixes actually differ", () => {
    const result = computeTabLabels([
      { documentPath: "a/shared/data/index.json", fallback: "", id: "a" },
      { documentPath: "b/shared/data/index.json", fallback: "", id: "b" },
    ]);
    expect(result.get("a")).toBe("a/shared/data/index.json");
    expect(result.get("b")).toBe("b/shared/data/index.json");
  });

  test("two tabs on the same path stop widening instead of looping", () => {
    const result = computeTabLabels([
      { documentPath: "components/card.json", fallback: "", id: "a" },
      { documentPath: "components/card.json", fallback: "", id: "b" },
    ]);
    expect(result.get("a")).toBe("components/card.json");
    expect(result.get("b")).toBe("components/card.json");
  });

  test("a pathless tab uses its fallback and is never widened", () => {
    const result = computeTabLabels([
      { documentPath: null, fallback: "orders (grid)", id: "a" },
      { documentPath: "components/card.json", fallback: "", id: "b" },
    ]);
    expect(result.get("a")).toBe("orders (grid)");
  });

  test("a bare filename with no directory is left as-is", () => {
    const result = computeTabLabels([{ documentPath: "project.json", fallback: "", id: "a" }]);
    expect(result.get("a")).toBe("project.json");
  });
});

describe("tabLabel", () => {
  test("names one tab for the close dialog", () => {
    const tab = { documentPath: "pages/blog/index.md", id: "x" } as Tab;
    expect(tabLabel(tab)).toBe("/blog");
    expect(tabLabel({ documentPath: "components/card.json", id: "y" } as Tab)).toBe("card.json");
  });

  test("falls back to Untitled with no path and no grid label", () => {
    expect(tabLabel({ documentPath: null, id: "y" } as Tab)).toBe("Untitled");
  });
});

describe("rendered labels", () => {
  test("routes reach the strip", async () => {
    open("a", "pages/index.md");
    open("b", "pages/blog/index.md");
    await flush();
    expect(labels()).toEqual(["/", "/blog"]);
  });

  test("colliding basenames widen in the strip", async () => {
    open("a", "content/posts/index.json");
    open("b", "content/notes/index.json");
    await flush();
    expect(labels()).toEqual(["posts/index.json", "notes/index.json"]);
  });

  test("a tab that vanishes mid-render is skipped", async () => {
    open("a");
    open("b");
    await flush();
    workspace.tabs.delete("a");
    activePane().tabOrder = [...activePane().tabOrder];
    await flush();
    expect(labels()).toEqual(["/b"]);
  });
});

describe("drill-in relationship", () => {
  test("a drilled-in tab shows the marker and names its origin in the tooltip", async () => {
    open("parent", "pages/index.md");
    const child = openTab({
      document: { tagName: "div" },
      documentPath: "components/card.json",
      id: "components/card.json",
      openedFrom: { documentPath: "pages/index.md", tabId: "parent" },
    });
    expect(child.session.openedFrom).not.toBeNull();
    await flush();
    const chips = [...host.querySelectorAll(".tab-strip-tab")] as HTMLElement[];
    expect(chips[0]!.querySelector(".tab-strip-origin")).toBeNull();
    expect(chips[1]!.querySelector(".tab-strip-origin")!.textContent).toBe("↳");
    expect(chips[1]!.getAttribute("title")).toBe(
      "components/card.json\nOpened from pages/index.md",
    );
  });

  test("an ordinary tab's tooltip is just its path", async () => {
    open("a", "components/card.json");
    await flush();
    const chip = host.querySelector(".tab-strip-tab") as HTMLElement;
    expect(chip.getAttribute("title")).toBe("components/card.json");
  });
});

describe("overflow chevron", () => {
  test("absent while the strip fits", async () => {
    open("a");
    await flush();
    stubMetrics(strip(), 100, 100);
    expect(host.querySelector(".tab-strip-overflow")).toBeNull();
  });

  test("appears once the strip overflows, and lists the hidden tabs", async () => {
    open("a");
    open("b");
    await flush();
    // Force overflow, then poke a re-render so the measurement is taken again.
    stubMetrics(strip(), 500, 100);
    open("c");
    await flush();
    const chevron = host.querySelector(".tab-strip-overflow") as HTMLElement;
    expect(chevron).not.toBeNull();
    // ONE accessible name: `title` alone, with the glyph aria-hidden (guidelines §10).
    expect(chevron.getAttribute("title")).toBe("Show hidden tabs");
    expect(chevron.getAttribute("aria-label")).toBeNull();
    expect(chevron.querySelector("[aria-hidden]")!.textContent!.trim()).toBe("⌄");

    chevron.click();
    await flush();
    const items = [...document.querySelectorAll("#layer-popover sp-menu-item")];
    expect(items.map((el) => el.textContent?.trim())).toEqual(["/a", "/b", "/c"]);
  });

  test("choosing a hidden tab activates it and closes the menu", async () => {
    open("a");
    open("b");
    await flush();
    stubMetrics(strip(), 500, 100);
    open("c");
    await flush();
    (host.querySelector(".tab-strip-overflow") as HTMLElement).click();
    await flush();
    const first = document.querySelector("#layer-popover sp-menu-item") as HTMLElement;
    first.click();
    await flush();
    expect(workspace.activeTabId).toBe("a");
    expect(document.querySelector("#layer-popover sp-menu-item")).toBeNull();
  });

  test("re-opening the menu replaces the previous one", async () => {
    open("a");
    open("b");
    await flush();
    stubMetrics(strip(), 500, 100);
    open("c");
    await flush();
    const chevron = host.querySelector(".tab-strip-overflow") as HTMLElement;
    chevron.click();
    await flush();
    chevron.click();
    await flush();
    expect(document.querySelectorAll("#layer-popover sp-menu").length).toBe(1);
  });

  test("hiddenTabIds reports the chips outside the scroll viewport", async () => {
    open("a");
    open("b");
    open("c");
    await flush();
    const el = strip();
    stubMetrics(el, 500, 100);
    el.scrollLeft = 0;
    const chips = [...el.querySelectorAll(".tab-strip-tab")] as HTMLElement[];
    const place = (chip: HTMLElement, left: number, width: number) => {
      Object.defineProperty(chip, "offsetLeft", { configurable: true, value: left });
      Object.defineProperty(chip, "offsetWidth", { configurable: true, value: width });
    };
    place(chips[0]!, 0, 40);
    place(chips[1]!, 40, 40);
    place(chips[2]!, 200, 40);
    expect(hiddenTabIds()).toEqual(["c"]);
    el.scrollLeft = 200;
    expect(hiddenTabIds()).toEqual(["a", "b"]);
  });

  test("hiddenTabIds is empty with no strip mounted", () => {
    unmount();
    expect(hiddenTabIds()).toEqual([]);
  });

  test("dismissing with no menu open is a no-op", () => {
    expect(() => dismissOverflowMenu()).not.toThrow();
  });
});
