/** Tests for src/panels/imports-panel.ts — context-aware import manager. */
import { flush, installMockPlatform, renderInto, resetStudioState } from "./harness";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { renderImportsTemplate } from "../src/panels/imports-panel";
import { componentRegistry, loadComponentRegistry } from "../src/files/components";
import { initLayers } from "../src/ui/layers";
import { requireProjectState } from "../src/store";

import type { ElementsEntry } from "../src/panels/imports-panel";
import type { ComponentEntry } from "../src/files/components";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { StudioPlatform } from "../src/types";

const REGISTRY: ComponentEntry[] = [
  { modulePath: "button.js", package: "@acme/kit", source: "npm", tagName: "x-button" },
  { modulePath: "card.js", package: "@acme/kit", source: "npm", tagName: "x-card" },
  { modulePath: "thing.js", package: "legacy-pkg", source: "npm", tagName: "y-thing" },
  // Missing modulePath — skipped by groupByPackage
  { package: "badpkg", source: "npm", tagName: "z-bad" },
  { path: "components/card.json", source: "project", tagName: "my-card" },
  { path: "components/hero.json", source: "project", tagName: "my-hero" },
];

let platform: StudioPlatform;
let renders = 0;
const renderLeftPanel = () => {
  renders += 1;
};
let calls: unknown[][];
let discoverCount = 0;

beforeAll(async () => {
  for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
    if (!document.querySelector(`#${id}`)) {
      const div = document.createElement("div");
      div.id = id;
      document.body.append(div);
    }
  }
  initLayers();
});

beforeEach(async () => {
  discoverCount = 0;
  const installed = installMockPlatform({
    discoverComponents: async () => {
      discoverCount += 1;
      return structuredClone(REGISTRY) as never;
    },
  });
  ({ platform } = installed);
  ({ calls } = installed.state);
  renders = 0;
  resetStudioState({
    projectConfig: {
      $elements: ["@acme/kit/button.js", "legacy-pkg"],
      imports: { Foo: "./foo.js" },
      name: "test",
    },
  });
  await loadComponentRegistry();
});

function lastWrittenConfig(): Record<string, unknown> {
  const writes = calls.filter((c) => c[0] === "writeFile" && c[1] === "project.json");
  expect(writes.length).toBeGreaterThan(0);
  return JSON.parse(writes.at(-1)![2] as string);
}

function siteCtx() {
  return {
    applyMutation: () => {},
    documentElements: [] as ElementsEntry[],
    documentPath: "project.json",
    renderLeftPanel,
  };
}

async function renderSite() {
  return renderInto(renderImportsTemplate(siteCtx()));
}

describe("site-level imports (project.json)", () => {
  test("lists class imports with count and package sections", async () => {
    const container = await renderSite();
    expect(container.querySelector(".imports-count")?.textContent).toBe("1");
    expect(container.textContent).toContain("Foo");
    expect(container.textContent).toContain("./foo.js");
    const sections = [...container.querySelectorAll(".imports-section-title")].map(
      (s) => s.textContent,
    );
    expect(sections).toContain("@acme/kit");
    expect(sections).toContain("legacy-pkg");
    expect(sections).not.toContain("badpkg");
    expect(sections).toContain("Add Dependency");
  });

  test("with no imported modules it teaches what an import buys", async () => {
    resetStudioState({ projectConfig: { name: "t" } });
    const container = await renderSite();
    expect(container.textContent).toContain(
      "Imported modules give this project extra kinds of data",
    );
  });

  test("checkbox state reflects cherry-picked and legacy imports", async () => {
    const container = await renderSite();
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const byLabel = new Map(boxes.map((b) => [b.textContent?.trim(), b.checked]));
    expect(byLabel.get("<x-button>")).toBe(true); // Cherry-picked specifier
    expect(byLabel.get("<x-card>")).toBe(false);
    expect(byLabel.get("<y-thing>")).toBe(true); // Legacy full-package import
  });

  test("removing a class import updates site config", async () => {
    const container = await renderSite();
    const removeBtn = container.querySelector(
      ".import-row sp-action-button[title='Remove']",
    ) as HTMLElement;
    removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(lastWrittenConfig().imports).toEqual({});
    expect(renders).toBe(1);
    expect(requireProjectState().projectConfig?.imports).toEqual({});
  });

  test("adding a class import writes name/path pair and clears the fields", async () => {
    const container = await renderSite();
    const name = container.querySelector(".import-add-name") as HTMLInputElement;
    const path = container.querySelector(".import-add-path") as HTMLInputElement;
    name.value = "Bar";
    path.value = "./bar.js";
    const addBtn = container.querySelector(
      ".import-add-form sp-action-button[title='Add import']",
    ) as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(lastWrittenConfig().imports).toEqual({ Bar: "./bar.js", Foo: "./foo.js" });
    expect(name.value).toBe("");
    expect(path.value).toBe("");
  });

  test("adding a class import with missing fields is a no-op", async () => {
    const container = await renderSite();
    const name = container.querySelector(".import-add-name") as HTMLInputElement;
    name.value = "OnlyName";
    const addBtn = container.querySelector(
      ".import-add-form sp-action-button[title='Add import']",
    ) as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(calls.filter((c) => c[0] === "writeFile").length).toBe(0);
    expect(renders).toBe(0);
  });

  test("checking a component checkbox cherry-picks it and drops legacy package import", async () => {
    const container = await renderSite();
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const yThing = boxes.find((b) => b.textContent?.includes("y-thing"))!;
    yThing.checked = true;
    yThing.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(lastWrittenConfig().$elements).toEqual(["@acme/kit/button.js", "legacy-pkg/thing.js"]);
  });

  test("checking an already-enabled component does not duplicate the entry", async () => {
    const container = await renderSite();
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const xButton = boxes.find((b) => b.textContent?.includes("x-button"))!;
    xButton.checked = true;
    xButton.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(lastWrittenConfig().$elements).toEqual(["@acme/kit/button.js", "legacy-pkg"]);
  });

  test("unchecking a component removes its specifier", async () => {
    const container = await renderSite();
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const xButton = boxes.find((b) => b.textContent?.includes("x-button"))!;
    xButton.checked = false;
    xButton.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(lastWrittenConfig().$elements).toEqual(["legacy-pkg"]);
  });

  test("removing a package confirms, removes its elements and reloads the registry", async () => {
    const container = await renderSite();
    const removeBtn = container.querySelector(
      ".imports-section-header sp-action-button[title='Remove package']",
    ) as HTMLElement;
    removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("headline")).toBe("Remove Package");
    dialog.dispatchEvent(new Event("confirm"));
    await flush(4);
    expect(calls.some((c) => c[0] === "removePackage" && c[1] === "@acme/kit")).toBe(true);
    // Cherry-picked @acme/kit elements stripped; legacy-pkg untouched
    expect(lastWrittenConfig().$elements).toEqual(["legacy-pkg"]);
    expect(discoverCount).toBeGreaterThan(1);
    expect(renders).toBe(1);
  });

  test("cancelling package removal leaves everything untouched", async () => {
    const container = await renderSite();
    const removeBtn = container.querySelector(
      ".imports-section-header sp-action-button[title='Remove package']",
    ) as HTMLElement;
    removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
    dialog.dispatchEvent(new Event("cancel"));
    await flush(4);
    expect(calls.some((c) => c[0] === "removePackage")).toBe(false);
    expect(renders).toBe(0);
  });

  test("package removal failure is caught and does not re-render", async () => {
    platform.removePackage = async () => {
      throw new Error("nope");
    };
    const container = await renderSite();
    const removeBtn = container.querySelector(
      ".imports-section-header sp-action-button[title='Remove package']",
    ) as HTMLElement;
    removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
    dialog.dispatchEvent(new Event("confirm"));
    await flush(4);
    expect(renders).toBe(0);
  });

  test("pressing Enter in the add-dependency field installs the package", async () => {
    const container = await renderSite();
    const field = container.querySelector(
      "sp-textfield[placeholder='Package name…']",
    ) as HTMLInputElement;
    field.value = "new-pkg";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush(4);
    expect(calls.some((c) => c[0] === "addPackage" && c[1] === "new-pkg")).toBe(true);
    expect(field.value).toBe("");
    expect(renders).toBe(1);
  });

  test("non-Enter keys and empty names do not install anything", async () => {
    const container = await renderSite();
    const field = container.querySelector(
      "sp-textfield[placeholder='Package name…']",
    ) as HTMLInputElement;
    field.value = "new-pkg";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    field.value = "   ";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush();
    expect(calls.some((c) => c[0] === "addPackage")).toBe(false);
  });

  test("add-package button installs the typed package", async () => {
    const container = await renderSite();
    const field = container.querySelector(
      "sp-textfield[placeholder='Package name…']",
    ) as HTMLInputElement;
    field.value = "btn-pkg";
    const addBtn = container.querySelector("sp-action-button[title='Add package']") as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(4);
    expect(calls.some((c) => c[0] === "addPackage" && c[1] === "btn-pkg")).toBe(true);
    expect(field.value).toBe("");
    expect(renders).toBe(1);
  });

  test("add-package button with empty field is a no-op", async () => {
    const container = await renderSite();
    const addBtn = container.querySelector("sp-action-button[title='Add package']") as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(calls.some((c) => c[0] === "addPackage")).toBe(false);
  });

  test("add-package failure is caught", async () => {
    platform.addPackage = async () => {
      throw new Error("registry down");
    };
    const container = await renderSite();
    const field = container.querySelector(
      "sp-textfield[placeholder='Package name…']",
    ) as HTMLInputElement;
    field.value = "broken";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush(4);
    expect(renders).toBe(0);
  });
});

describe("document-level imports", () => {
  let doc: JxMutableNode;

  function docCtx(overrides: Record<string, unknown> = {}) {
    return {
      applyMutation: (fn: (d: JxMutableNode) => void) => fn(doc),
      documentElements: (doc.$elements || []) as ElementsEntry[],
      documentPath: "pages/index.json",
      renderLeftPanel,
      ...overrides,
    };
  }

  beforeEach(() => {
    doc = {
      $elements: [{ $ref: "./components/hero.json" }, "@acme/kit/button.js", "legacy-pkg"],
      tagName: "div",
    } as unknown as JxMutableNode;
  });

  test("lists $ref imports and offers only un-imported project components", async () => {
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    expect(container.querySelector(".imports-count")?.textContent).toBe("1");
    expect(container.textContent).toContain("./components/hero.json");
    const options = [...container.querySelectorAll(".import-picker sp-menu-item")].map(
      (i) => i.textContent,
    );
    expect(options).toEqual(["<my-card>"]);
  });

  test("with no component imports it teaches what they buy, and names the picker below", async () => {
    doc.$elements = ["@acme/kit/button.js"];
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    expect(container.querySelector(".empty-state-message")?.textContent).toBe(
      "Components you add here can be dropped onto this page. Pick one below.",
    );
  });

  test("with no project components at all it says where components come from", async () => {
    doc.$elements = [];
    componentRegistry.length = 0;
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    expect(container.querySelector(".empty-state-message")?.textContent).toContain(
      "This project has none yet",
    );
  });

  test("removing a $ref import filters it out of $elements", async () => {
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const removeBtn = container.querySelector(
      ".import-row sp-action-button[title='Remove']",
    ) as HTMLElement;
    removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(doc.$elements).toEqual(["@acme/kit/button.js", "legacy-pkg"]);
    expect(renders).toBe(1);
  });

  test("picking a component adds a relative $ref", async () => {
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const pickerEl = container.querySelector(".import-picker") as HTMLElement & { value: string };
    pickerEl.value = "my-card";
    pickerEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc.$elements).toContainEqual({ $ref: "../components/card.json" });
    expect(pickerEl.value).toBe("");
    expect(renders).toBe(1);
  });

  test("picking a component initializes $elements when missing", async () => {
    doc = { tagName: "div" } as unknown as JxMutableNode;
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const pickerEl = container.querySelector(".import-picker") as HTMLElement & { value: string };
    pickerEl.value = "my-hero";
    pickerEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc.$elements).toEqual([{ $ref: "../components/hero.json" }]);
  });

  test("picker ignores empty values and components without a path", async () => {
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const pickerEl = container.querySelector(".import-picker") as HTMLElement & { value: string };
    pickerEl.value = "";
    pickerEl.dispatchEvent(new Event("change", { bubbles: true }));
    // X-button is an npm component without a project path
    pickerEl.value = "x-button";
    pickerEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc.$elements).toEqual([
      { $ref: "./components/hero.json" },
      "@acme/kit/button.js",
      "legacy-pkg",
    ]);
    expect(renders).toBe(0);
  });

  test("documentPath null produces ./-relative refs", async () => {
    doc = { tagName: "div" } as unknown as JxMutableNode;
    const container = await renderInto(
      renderImportsTemplate(docCtx({ documentPath: null }) as never),
    );
    const pickerEl = container.querySelector(".import-picker") as HTMLElement & { value: string };
    pickerEl.value = "my-card";
    pickerEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc.$elements).toEqual([{ $ref: "./components/card.json" }]);
  });

  test("npm checkboxes mirror enabled state from string entries", async () => {
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const byLabel = new Map(boxes.map((b) => [b.textContent?.trim(), b.checked]));
    expect(byLabel.get("<x-button>")).toBe(true);
    expect(byLabel.get("<x-card>")).toBe(false);
    expect(byLabel.get("<y-thing>")).toBe(true);
  });

  test("checking an npm component pushes its specifier and drops the legacy entry", async () => {
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const yThing = boxes.find((b) => b.textContent?.includes("y-thing"))!;
    yThing.checked = true;
    yThing.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc.$elements).toEqual([
      { $ref: "./components/hero.json" },
      "@acme/kit/button.js",
      "legacy-pkg/thing.js",
    ]);
    expect(renders).toBe(1);
  });

  test("unchecking an npm component removes its specifier", async () => {
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const xButton = boxes.find((b) => b.textContent?.includes("x-button"))!;
    xButton.checked = false;
    xButton.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc.$elements).toEqual([{ $ref: "./components/hero.json" }, "legacy-pkg"]);
  });

  test("checking a component initializes $elements when missing", async () => {
    doc = { tagName: "div" } as unknown as JxMutableNode;
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const xCard = boxes.find((b) => b.textContent?.includes("x-card"))!;
    xCard.checked = true;
    xCard.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc.$elements).toEqual(["@acme/kit/card.js"]);
  });

  test("checking an already-listed specifier does not duplicate it", async () => {
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    const boxes = [...container.querySelectorAll("sp-checkbox")] as (HTMLElement & {
      checked: boolean;
    })[];
    const xButton = boxes.find((b) => b.textContent?.includes("x-button"))!;
    xButton.checked = true;
    xButton.dispatchEvent(new Event("change", { bubbles: true }));
    expect(
      (doc.$elements as ElementsEntry[]).filter((e) => e === "@acme/kit/button.js").length,
    ).toBe(1);
  });

  test("no $ref imports and no available components renders neither list nor picker", async () => {
    doc = {
      $elements: [{ $ref: "./components/hero.json" }, { $ref: "./components/card.json" }],
      tagName: "div",
    } as unknown as JxMutableNode;
    const container = await renderInto(renderImportsTemplate(docCtx() as never));
    expect(container.querySelector(".import-picker")).toBeNull();
    doc = { $elements: [], tagName: "div" } as unknown as JxMutableNode;
    const container2 = await renderInto(renderImportsTemplate(docCtx() as never));
    expect(container2.querySelector(".imports-list:not(.imports-component-list)")).toBeNull();
  });
});
