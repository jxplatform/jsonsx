/**
 * Mixed values across a multi-selection, in all three inspector tabs (§6.5, P5 item 2).
 *
 * Mixed is a fifth state of the SAME provenance chip workstreams A and C built, not a fifth widget.
 * Two things are asserted everywhere:
 *
 * 1. **A selection of one renders no Mixed state anywhere.** There is no second value to disagree
 *    with, so every row keeps the exact chip it had before the selection became a list.
 * 2. **A commit reaches every selected element, in ONE transaction** — one undo step for one decision,
 *    which is what makes "set padding on six cards" a thing you can take back.
 */
import {
  flush,
  installMockPlatform,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as storeActual from "../src/store";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";

void mock.module("../src/store", () => ({
  ...storeActual,
  debouncedStyleCommit:
    <A extends unknown[]>(_prop: string, _ms: number, fn: (...args: A) => void) =>
    (...args: A) =>
      fn(...args),
}));
void mock.module("../src/panels/stylebook-panel", () => ({ selectStylebookTag: () => {} }));
void mock.module("../src/commands/active-registry", () => ({
  activeRegistry: () => ({ run: () => {} }),
}));

const { renderStylePanelTemplate } = await import("../src/panels/style-panel");
const { renderPropertiesPanelTemplate } = await import("../src/panels/properties-panel");
const { renderLogicPanelTemplate } = await import("../src/panels/events-panel");
const { initCssData } = await import("../src/panels/style-utils");
const { initLayers } = await import("../src/ui/layers");
const { getNodeAtPath } = await import("../src/store");

(globalThis as Record<string, unknown>).requestAnimationFrame ??= (cb: (t: number) => void) =>
  setTimeout(() => cb(0), 0);

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

const A = ["children", 0];
const B = ["children", 1];

/** Two images that disagree twice over: their aspect ratio and their alt text. */
function twoCards(): JxMutableNode {
  return {
    children: [
      { attributes: { alt: "one" }, style: { aspectRatio: "1/1" }, tagName: "img" },
      { attributes: { alt: "two" }, style: { aspectRatio: "16/9" }, tagName: "img" },
    ],
    tagName: "div",
  } as unknown as JxMutableNode;
}

/** The same two, agreeing about everything. */
function twoIdenticalCards(): JxMutableNode {
  return {
    children: [
      { attributes: { alt: "same" }, style: { aspectRatio: "1/1" }, tagName: "img" },
      { attributes: { alt: "same" }, style: { aspectRatio: "1/1" }, tagName: "img" },
    ],
    tagName: "div",
  } as unknown as JxMutableNode;
}

function setup(doc: JxMutableNode, selection: (string | number)[][]) {
  resetStudioState();
  const tab = resetWorkspaceWithTab(doc);
  tab.session.selection = selection;
  return tab;
}

function node(path: (string | number)[]): JxMutableNode {
  return getNodeAtPath(activeTab.value!.doc.document, path);
}

const styleRow = (c: HTMLElement, prop: string) =>
  c.querySelector(`.style-row[data-prop="${prop}"]`) as HTMLElement | null;
const contentRow = (c: HTMLElement, prop: string) =>
  c.querySelector(`[data-prop="${prop}"]`) as HTMLElement | null;
const chip = (row: HTMLElement | null) =>
  row?.querySelector(".provenance-chip") as HTMLElement | null;

const renderStyle = () => renderInto(renderStylePanelTemplate({ getCanvasMode: () => "edit" }));
const renderContent = () =>
  renderInto(renderPropertiesPanelTemplate({ navigateToComponent: () => {} }));
const renderLogic = () => renderInto(renderLogicPanelTemplate({ isCustomElementDoc: () => false }));

beforeEach(() => {
  installMockPlatform();
  initCssData({ cssProps: [["aspect-ratio", "auto"]] });
});

afterEach(() => {
  closeAllTabs();
});

// ─── Style ───────────────────────────────────────────────────────────────────

describe("Style tab", () => {
  test("one selected element renders the ordinary set chip, never Mixed", async () => {
    setup(twoCards(), [A]);
    const c = await renderStyle();
    const dot = chip(styleRow(c, "aspectRatio"));
    expect(dot?.classList.contains("provenance-chip--mixed")).toBe(false);
    expect(dot?.classList.contains("provenance-chip--set")).toBe(true);
  });

  test("two elements that disagree render Mixed, naming how many", async () => {
    setup(twoCards(), [A, B]);
    const c = await renderStyle();
    const dot = chip(styleRow(c, "aspectRatio"))!;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(true);
    expect(dot.textContent!.trim()).toBe("mixed (2)");
    expect(dot.getAttribute("title")).toContain("different values for aspectRatio");
  });

  test("two elements that agree are not Mixed — they are simply set", async () => {
    setup(twoIdenticalCards(), [A, B]);
    const c = await renderStyle();
    const dot = chip(styleRow(c, "aspectRatio"))!;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(false);
    expect(dot.classList.contains("provenance-chip--set")).toBe(true);
  });

  test("typing into a Mixed field sets every selected element, in ONE undo step", async () => {
    const tab = setup(twoCards(), [A, B]);
    const before = tab.history.index;
    const c = await renderStyle();
    const input = styleRow(c, "aspectRatio")!.querySelector(
      "jx-value-selector, sp-textfield, input",
    ) as HTMLInputElement;
    input.value = "4/3";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(node(A).style!.aspectRatio).toBe("4/3");
    expect(node(B).style!.aspectRatio).toBe("4/3");
    expect(tab.history.index).toBe(before + 1);
  });

  test("clearing a Mixed field clears it from every selected element, in one step", async () => {
    const tab = setup(twoCards(), [A, B]);
    const before = tab.history.index;
    const c = await renderStyle();
    chip(styleRow(c, "aspectRatio"))!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(node(A).style?.padding).toBeUndefined();
    expect(node(B).style?.padding).toBeUndefined();
    expect(tab.history.index).toBe(before + 1);
  });
});

// ─── Style: shorthands ───────────────────────────────────────────────────────

/**
 * Shorthands were the one Style row that never learned either half of §6.5.
 *
 * `padding`, `margin` and `border` are `$shorthand: true`, and "you can set padding on six cards in
 * one decision" is the literal sentence the plan makes — with padding as its example. The row wrote
 * to the primary element only, for the header field AND for every longhand child, and drew a plain
 * "Clear padding" dot over a property `mixedStyleProps` had already computed as mixed.
 */
function twoSections(styles: [JxMutableNode["style"], JxMutableNode["style"]]): JxMutableNode {
  return {
    children: [
      { style: styles[0], tagName: "section" },
      { style: styles[1], tagName: "section" },
    ],
    tagName: "div",
  } as unknown as JxMutableNode;
}

const shorthandField = (c: HTMLElement, prop: string) =>
  styleRow(c, prop)!.querySelector(".style-shorthand-header sp-textfield") as HTMLInputElement;

describe("Style tab — shorthand rows", () => {
  test("typing a shorthand writes it to EVERY selected element, in ONE undo step", async () => {
    const tab = setup(twoSections([{ padding: "4px" }, { padding: "20px" }]), [A, B]);
    const before = tab.history.index;
    const c = await renderStyle();
    const field = shorthandField(c, "padding");
    field.value = "12px";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(node(A).style!.padding).toBe("12px");
    expect(node(B).style!.padding).toBe("12px");
    expect(tab.history.index).toBe(before + 1);
  });

  test("a shorthand the selection disagrees about says Mixed, not 'clear'", async () => {
    setup(twoSections([{ padding: "4px" }, { padding: "20px" }]), [A, B]);
    const c = await renderStyle();
    const dot = chip(styleRow(c, "padding"))!;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(true);
    expect(dot.textContent!.trim()).toBe("mixed (2)");
    // The plain clear dot is what the row used to offer INSTEAD of saying so.
    expect(dot.classList.contains("set-dot")).toBe(false);
  });

  test("a shorthand is Mixed when the selection disagrees about one of its longhands", async () => {
    setup(twoSections([{ paddingTop: "4px" }, { paddingTop: "9px" }]), [A, B]);
    const c = await renderStyle();
    expect(chip(styleRow(c, "padding"))!.textContent!.trim()).toBe("mixed (2)");
    // And so is the child row the disagreement is actually about.
    expect(chip(styleRow(c, "paddingTop"))!.textContent!.trim()).toBe("mixed (2)");
  });

  test("a shorthand the selection agrees about is simply set", async () => {
    setup(twoSections([{ padding: "4px" }, { padding: "4px" }]), [A, B]);
    const c = await renderStyle();
    const dot = chip(styleRow(c, "padding"))!;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(false);
    expect(dot.classList.contains("provenance-chip--set")).toBe(true);
  });

  // The rows show the PRIMARY element's values — `primarySelection` is the last path selected — so
  // The four child rows are filled by B's shorthand, and the edit lands on both elements.
  test("editing a longhand child recompresses the shorthand on every element", async () => {
    const tab = setup(twoSections([{ padding: "9px" }, { padding: "1px 2px 3px 4px" }]), [A, B]);
    tab.session.ui.styleShorthands = { padding: true };
    const before = tab.history.index;
    const c = await renderStyle();
    const child = styleRow(c, "paddingTop")!.querySelector(
      "jx-value-selector, sp-textfield, input",
    ) as HTMLInputElement;
    child.value = "7px";
    child.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(node(A).style!.padding).toBe("7px 2px 3px 4px");
    expect(node(B).style!.padding).toBe("7px 2px 3px 4px");
    expect(tab.history.index).toBe(before + 1);
  });

  test("clearing a Mixed shorthand clears it, and its longhands, everywhere", async () => {
    const tab = setup(twoSections([{ padding: "4px" }, { paddingLeft: "20px" }]), [A, B]);
    const before = tab.history.index;
    const c = await renderStyle();
    chip(styleRow(c, "padding"))!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(node(A).style).toBeUndefined();
    expect(node(B).style).toBeUndefined();
    expect(tab.history.index).toBe(before + 1);
  });

  test("a section's clear-all dot clears the section on every selected element", async () => {
    const tab = setup(twoSections([{ padding: "4px" }, { padding: "4px" }]), [A, B]);
    const before = tab.history.index;
    const c = await renderStyle();
    const spacing = [...c.querySelectorAll("sp-accordion-item")].find(
      (el) => el.getAttribute("label") === "Spacing",
    )!;
    spacing
      .querySelector(".provenance-dots .provenance-chip--set")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(node(A).style).toBeUndefined();
    expect(node(B).style).toBeUndefined();
    expect(tab.history.index).toBe(before + 1);
  });

  test("renaming a custom property renames it on every element, keeping each value", async () => {
    const tab = setup(twoSections([{ "--brand": "red" }, { "--brand": "blue" }]), [A, B]);
    const before = tab.history.index;
    const c = await renderStyle();
    const key = c.querySelector(".kv-row .kv-key") as HTMLInputElement;
    key.value = "--accent";
    key.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(node(A).style).toEqual({ "--accent": "red" });
    expect(node(B).style).toEqual({ "--accent": "blue" });
    expect(tab.history.index).toBe(before + 1);
  });
});

// ─── Content ─────────────────────────────────────────────────────────────────

describe("Content tab", () => {
  test("one selected element renders the ordinary set chip on an attribute row", async () => {
    setup(twoCards(), [A]);
    const c = await renderContent();
    const dot = chip(contentRow(c, "alt"));
    expect(dot?.classList.contains("provenance-chip--mixed")).toBe(false);
  });

  test("two elements with different alt text render Mixed", async () => {
    setup(twoCards(), [A, B]);
    const c = await renderContent();
    const dot = chip(contentRow(c, "alt"))!;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(true);
    expect(dot.textContent!.trim()).toBe("mixed (2)");
  });

  test("two elements with the same alt text are not Mixed", async () => {
    setup(twoIdenticalCards(), [A, B]);
    const c = await renderContent();
    const dot = chip(contentRow(c, "alt"))!;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(false);
  });

  test("clearing a Mixed attribute clears it everywhere, in ONE undo step", async () => {
    const tab = setup(twoCards(), [A, B]);
    const before = tab.history.index;
    const c = await renderContent();
    chip(contentRow(c, "alt"))!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(node(A).attributes?.href).toBeUndefined();
    expect(node(B).attributes?.href).toBeUndefined();
    expect(tab.history.index).toBe(before + 1);
  });
});

// ─── Logic ───────────────────────────────────────────────────────────────────

/** Two buttons whose click handlers differ, so the event row has something to disagree about. */
function twoButtons(sameHandler: boolean): JxMutableNode {
  return {
    children: [
      { onclick: { $ref: "#/state/go" }, tagName: "button" },
      { onclick: { $ref: sameHandler ? "#/state/go" : "#/state/stop" }, tagName: "button" },
    ],
    state: {
      go: { $prototype: "Function", body: "", parameters: [] },
      stop: { $prototype: "Function", body: "", parameters: [] },
    },
    tagName: "div",
  } as unknown as JxMutableNode;
}

describe("Logic tab", () => {
  test("one selected element renders the ordinary set chip on its event row", async () => {
    setup(twoButtons(false), [A]);
    const c = await renderLogic();
    const dot = c.querySelector(".provenance-chip") as HTMLElement;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(false);
    expect(dot.classList.contains("provenance-chip--set")).toBe(true);
  });

  test("two elements bound to different handlers render Mixed on that event", async () => {
    setup(twoButtons(false), [A, B]);
    const c = await renderLogic();
    const dot = c.querySelector(".provenance-chip") as HTMLElement;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(true);
    expect(dot.getAttribute("title")).toContain("bind onclick differently");
  });

  test("two elements bound to the same handler are not Mixed", async () => {
    setup(twoButtons(true), [A, B]);
    const c = await renderLogic();
    const dot = c.querySelector(".provenance-chip") as HTMLElement;
    expect(dot.classList.contains("provenance-chip--mixed")).toBe(false);
  });

  test("clearing an event removes it from every selected element, in ONE undo step", async () => {
    const tab = setup(twoButtons(false), [A, B]);
    const before = tab.history.index;
    const c = await renderLogic();
    (c.querySelector(".provenance-chip") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(node(A).onclick).toBeUndefined();
    expect(node(B).onclick).toBeUndefined();
    expect(tab.history.index).toBe(before + 1);
  });

  test("changing the Value Source rung rewires every selected element in one step", async () => {
    const tab = setup(twoButtons(false), [A, B]);
    const before = tab.history.index;
    const c = await renderLogic();
    const mode = c.querySelector(".event-mode") as HTMLInputElement;
    mode.value = "function";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect((node(A).onclick as Record<string, unknown>).$prototype).toBe("Function");
    expect((node(B).onclick as Record<string, unknown>).$prototype).toBe("Function");
    expect(tab.history.index).toBe(before + 1);
  });
});
