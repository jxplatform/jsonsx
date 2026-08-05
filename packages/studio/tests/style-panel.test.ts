import {
  answerPromptDialog,
  flush,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
  topDialog,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as storeActual from "../src/store";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";
import { shell } from "../src/shell";

// Make debounced style commits synchronous so @input handlers fire without real 400ms timers.
void mock.module("../src/store", () => ({
  ...storeActual,
  debouncedStyleCommit:
    <A extends unknown[]>(_prop: string, _ms: number, fn: (...args: A) => void) =>
    (...args: A) =>
      fn(...args),
}));

// Stub the stylebook panel so nested-rule navigation doesn't drag in canvas panning.
const selectStylebookTagMock = mock((..._args: unknown[]) => {});
void mock.module("../src/panels/stylebook-panel", () => ({
  selectStylebookTag: selectStylebookTagMock,
}));

// The Target Line's segments route to commands rather than growing their own selectors, so the
// Registry is what the tests assert against — the segment's job is to name the right verb.
const runMock = mock((..._args: unknown[]) => {});
void mock.module("../src/commands/active-registry", () => ({
  activeRegistry: () => ({ run: runMock }),
}));

const { _fieldRow, renderStylePanelTemplate, resetSelectorMenu } =
  await import("../src/panels/style-panel");
const { openSelectorMenu } = await import("../src/panels/target-line");
const { initCssData } = await import("../src/panels/style-utils");
const { initLayers } = await import("../src/ui/layers");
const { getNodeAtPath } = await import("../src/store");
const { resetSlotModeMemory } = await import("../src/ui/dynamic-slot");

// Happy-dom may not provide requestAnimationFrame in all versions.
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (cb: (t: number) => void) =>
  setTimeout(() => cb(0), 0);

// The nested-selector "+ Add" affordance opens a real Spectrum prompt dialog, so the panel needs
// The overlay layers mounted.
for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

const MEDIA = { md: "(min-width: 768px)", sm: "(min-width: 640px)" };

function setupTab(style: JxStyle | undefined, opts: { media?: boolean } = {}) {
  resetStudioState();
  const doc = {
    children: [{ ...(style ? { style } : {}), tagName: "section" }],
    tagName: "div",
    ...(opts.media ? { $media: MEDIA } : {}),
  } as unknown as JxMutableNode;
  const tab = resetWorkspaceWithTab(doc);
  tab.session.selection = [["children", 0]];
  return tab;
}

function selectedNode(): JxMutableNode {
  return getNodeAtPath(activeTab.value!.doc.document, ["children", 0]);
}

async function renderPanel(mode = "edit") {
  return renderInto(renderStylePanelTemplate({ getCanvasMode: () => mode }));
}

function row(container: HTMLElement, prop: string) {
  return container.querySelector(`.style-row[data-prop="${prop}"]`) as HTMLElement | null;
}

function accordionItem(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("sp-accordion-item")].find(
    (el) => el.getAttribute("label") === label,
  ) as HTMLElement | undefined;
}

function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function fire(el: Element | null | undefined, type: string, value?: string) {
  expect(el).toBeTruthy();
  if (value !== undefined) {
    (el as HTMLInputElement).value = value;
  }
  el!.dispatchEvent(new Event(type, { bubbles: true }));
}

/** One segment of the Target Line, addressed by the axis it states. */
function segment(container: HTMLElement, key: string) {
  return container.querySelector(`.target-line [data-seg="${key}"]`) as HTMLElement | null;
}

/** The trailing scope chip — "this element" / "all <h1> in this document". */
function scopeChip(container: HTMLElement) {
  return container.querySelector(".target-line .tl-scope") as HTMLElement | null;
}

/** A row's provenance chip, whatever state it is in. */
function chip(container: HTMLElement, prop: string) {
  return row(container, prop)?.querySelector(".provenance-chip") as HTMLElement | null;
}

/** Pick a value-source rung from the dynamic slot's picker (§6.3 turned the ring into a menu). */
function chooseSlotMode(container: HTMLElement, prop: string, mode: string) {
  click(row(container, prop)!.querySelector(`sp-menu-item[data-mode="${mode}"]`));
}

function toggleAccordion(item: HTMLElement | undefined, open: boolean) {
  expect(item).toBeTruthy();
  (item as HTMLElement & { open: boolean }).open = open;
  item!.dispatchEvent(new Event("sp-accordion-item-toggle", { bubbles: true }));
}

beforeEach(() => {
  initCssData({
    cssProps: [
      ["display", "inline"],
      ["zoom", "1"],
    ],
  });
  selectStylebookTagMock.mockClear();
  runMock.mockClear();
  resetSelectorMenu();
  resetSlotModeMemory();
});

afterEach(() => {
  closeAllTabs();
});

// ─── Empty states ────────────────────────────────────────────────────────────

describe("renderStylePanelTemplate empty states", () => {
  test("no open tab → the shared open-a-page state, with the button that does it", async () => {
    resetStudioState();
    closeAllTabs();
    const c = await renderPanel();
    expect(c.querySelector(".empty-state-message")?.textContent).toBe(
      "Open a page to style what you click.",
    );
    expect((c.querySelector(".empty-state-action") as HTMLElement).textContent?.trim()).toBe(
      "Open a page…",
    );
  });

  test("tab without selection → the one shared canvas verb", async () => {
    resetStudioState();
    resetWorkspaceWithTab();
    const c = await renderPanel();
    // The rail must not read as three different requirements: Properties, Events and Style all
    // Ask for a selection with the same sentence.
    expect(c.querySelector(".empty-state-message")?.textContent).toBe(
      "Click anything on the canvas to style it.",
    );
  });

  test("selection pointing at a missing node → names the loss, then the shared verb", async () => {
    const tab = setupTab({});
    tab.session.selection = [["children", 9]];
    const c = await renderPanel();
    expect(c.querySelector(".empty-state-message")?.textContent).toBe(
      "That element is no longer on the page. Click anything on the canvas to pick another one.",
    );
  });

  test("stylebook mode with null document → the same open-a-page state", async () => {
    const tab = setupTab({});
    shell.stylebook.selection = "h1";
    (tab.doc as unknown as Record<string, unknown>).document = null;
    const c = await renderPanel("stylebook");
    expect(c.querySelector(".empty-state-message")?.textContent).toBe(
      "Open a page to style what you click.",
    );
  });
});

// ─── Stylebook mode ──────────────────────────────────────────────────────────

describe("stylebook mode", () => {
  test("the scope chip states the blast radius, and site style shows through as a donor", async () => {
    setupTab({});
    resetStudioState({ projectConfig: { style: { textAlign: "center" } } });
    shell.stylebook.selection = "h1";
    const c = await renderPanel("stylebook");
    // The `Styling: <h1>` caption is gone; the scope chip says the same thing before you type,
    // And says how far it reaches.
    expect(c.querySelector(".stylebook-style-header")).toBeNull();
    expect(segment(c, "element")?.textContent).toContain("h1");
    expect(scopeChip(c)?.textContent).toContain("all <h1> in this document");
    // The value comes from the project's site style, not from this document — so it is inherited,
    // With the donor named, rather than an accent dot whose "clear" would do nothing.
    const r = row(c, "textAlign");
    expect(r).not.toBeNull();
    expect(r!.querySelector(".set-dot")).toBeNull();
    expect(chip(c, "textAlign")?.textContent).toContain("from site tokens");
  });

  test("a layout's stylebook rule is project-wide, and the band says how wide", async () => {
    setupTab({});
    resetStudioState();
    activeTab.value!.documentPath = "layouts/base.json";
    shell.stylebook.selection = "h1";
    const c = await renderPanel("stylebook");
    expect(scopeChip(c)?.textContent).toContain("all <h1> in this project");
    // The harness platform answers no `findReferences`, so the honest count is "unknown" — never
    // A confident zero.
    expect(c.querySelector(".tl-warning-text")?.textContent).toContain("unknown");
  });
});

// ─── Base rows, conditions, commits ──────────────────────────────────────────

describe("base style rows", () => {
  test("renders set props, conditional rows, and auto-opens their sections", async () => {
    const tab = setupTab({ display: "flex", flexDirection: "row" });
    const c = await renderPanel();
    expect(row(c, "display")).not.toBeNull();
    const flexDir = row(c, "flexDirection");
    expect(flexDir).not.toBeNull();
    expect(flexDir!.classList.contains("style-row--warning")).toBe(false);
    // FlexWrap has no value but its $show condition (display: flex) passes
    expect(row(c, "flexWrap")).not.toBeNull();
    expect(tab.session.ui.styleSections.layout).toBe(true);
  });

  test("set value with failing $show condition renders a warning row", async () => {
    setupTab({ flexDirection: "row" });
    const c = await renderPanel();
    const flexDir = row(c, "flexDirection");
    expect(flexDir!.classList.contains("style-row--warning")).toBe(true);
    // FlexWrap: no value and condition unmet → skipped entirely
    expect(row(c, "flexWrap")).toBeNull();
  });

  test("row set-dot clears the property from the node style", async () => {
    setupTab({ display: "flex", flexDirection: "row" });
    const c = await renderPanel();
    click(row(c, "display")!.querySelector(".set-dot"));
    expect(selectedNode().style?.display).toBeUndefined();
    expect(selectedNode().style?.flexDirection).toBe("row");
    expect(activeTab.value!.doc.dirty).toBe(true);
  });

  test("$span 2 props in grid sections span both columns", async () => {
    setupTab({ boxSizing: "border-box" });
    const c = await renderPanel();
    const r = row(c, "boxSizing");
    expect(r!.getAttribute("style")).toContain("grid-column: 1 / -1");
    expect(c.querySelector(".style-section-body--grid")).not.toBeNull();
  });
});

// ─── Style value dynamic slots (fx affordance) ───────────────────────────────

describe("style value dynamic slots", () => {
  test("style rows offer literal and template only (no $ref in JxStyle)", async () => {
    setupTab({ display: "flex" });
    const c = await renderPanel();
    const mode = row(c, "display")!.querySelector(".style-row-label .dynamic-slot-mode")!;
    expect(mode).not.toBeNull();
    expect(mode.textContent!.trim()).toBe("Fixed value");
    const rungs = [...row(c, "display")!.querySelectorAll("sp-menu-item[data-mode]")].map(
      (m) => (m as HTMLElement).dataset.mode,
    );
    expect(rungs).toEqual(["literal", "template"]);
  });

  test("switching to template mode seeds a state-based template string", async () => {
    resetStudioState();
    const doc = {
      children: [{ style: { display: "flex" }, tagName: "section" }],
      state: { mode: { default: "grid" } },
      tagName: "div",
    } as unknown as JxMutableNode;
    const tab = resetWorkspaceWithTab(doc);
    tab.session.selection = [["children", 0]];
    const c = await renderPanel();
    chooseSlotMode(c, "display", "template");
    expect(selectedNode().style?.display).toBe("${state.mode}");
  });

  test("template-valued style renders the ${} textfield and commits edits", async () => {
    setupTab({ display: "${state.mode}" });
    const c = await renderPanel();
    const r = row(c, "display")!;
    expect(r.querySelector(".dynamic-slot-mode")!.textContent!.trim()).toBe("Mixed text");
    const tf = r.querySelector("sp-textfield") as HTMLInputElement;
    expect(tf.value).toBe("${state.mode}");
    fire(tf, "change", "${state.other}");
    expect(selectedNode().style?.display).toBe("${state.other}");
  });

  test("de-escalating a template value to literal clears the property", async () => {
    setupTab({ display: "${state.mode}" });
    const c = await renderPanel();
    chooseSlotMode(c, "display", "literal");
    expect(selectedNode().style).toBeUndefined();
  });

  test("cycling back to literal restores the stashed style value", async () => {
    setupTab({ display: "flex" });
    let c = await renderPanel();
    chooseSlotMode(c, "display", "template");
    expect(selectedNode().style?.display).toBe("${}");

    c = await renderPanel();
    chooseSlotMode(c, "display", "literal");
    expect(selectedNode().style?.display).toBe("flex");
  });
});

// ─── The Target Line (§6.1) ──────────────────────────────────────────────────

describe("the Target Line", () => {
  test("states the element and the base breakpoint, and scopes to the element", async () => {
    setupTab({});
    const c = await renderPanel();
    expect(segment(c, "element")?.textContent?.trim()).toBe("section");
    expect(segment(c, "media")?.textContent?.trim()).toBe("Base");
    expect(segment(c, "scheme")).toBeNull();
    expect(scopeChip(c)?.textContent?.trim()).toBe("this element");
    expect(c.querySelector(".tl-warning")).toBeNull();
  });

  test("names the active breakpoint, and every segment is a control", async () => {
    const tab = setupTab({}, { media: true });
    tab.session.ui.activeMedia = "md";
    const c = await renderPanel();
    expect(segment(c, "media")?.textContent?.trim()).toBe("@Md");
    // A segment is a button, and it routes rather than offering a third selector of its own.
    click(segment(c, "media"));
    expect(runMock).toHaveBeenCalledWith("settings.open", { section: "contexts" });
    click(segment(c, "element"));
    expect(runMock).toHaveBeenCalledWith("view.setActivity", { tab: "layers" });
  });

  test("the breakpoint segment reads Base while no breakpoint is declared", async () => {
    const tab = setupTab({});
    tab.session.ui.activeMedia = "md";
    const c = await renderPanel();
    expect(segment(c, "media")?.textContent?.trim()).toBe("Base");
  });

  test("the selector segment names the rule and lists what the element declares", async () => {
    const tab = setupTab({ "&.active": { color: "red" } });
    tab.session.ui.activeSelector = "&.custom";
    const c = await renderPanel();
    expect(segment(c, "selector")?.textContent).toContain("&.custom");
    const values = [...c.querySelectorAll(".tl-selector-menu sp-menu-item")].map((m) =>
      m.getAttribute("value"),
    );
    expect(values).toContain("&.active");
    expect(values).toContain("&.custom");
    expect(values).toContain("__base__");
    // A declared selector is marked, so the menu says which rules already exist.
    const active = [...c.querySelectorAll(".tl-selector-menu sp-menu-item")].find(
      (m) => m.getAttribute("value") === "&.active",
    );
    expect(active?.textContent).toContain("●");
  });

  test("choosing a menu entry sets the selector; the base entry clears it", async () => {
    const tab = setupTab({});
    const c = await renderPanel();
    const item = (value: string) =>
      [...c.querySelectorAll(".tl-selector-menu sp-menu-item")].find(
        (m) => m.getAttribute("value") === value,
      );
    click(item(":focus"));
    expect(tab.session.ui.activeSelector).toBe(":focus");
    click(item("__base__"));
    expect(tab.session.ui.activeSelector).toBeNull();
  });

  test("+ Add custom… opens a validated dialog, not an imperative input", async () => {
    const tab = setupTab({});
    let c = await renderPanel();
    const addCustom = (container: HTMLElement) =>
      click(
        [...container.querySelectorAll(".tl-selector-menu sp-menu-item")].find(
          (m) => m.getAttribute("value") === "__add_custom__",
        ),
      );

    addCustom(c);
    await flush();
    expect(topDialog()).not.toBeNull();
    expect(topDialog()!.getAttribute("headline")).toBe("Add Selector");
    // A value that is not a nested selector is refused in place.
    await answerPromptDialog("notASelector");
    expect(topDialog()!.querySelector("sp-help-text")?.textContent).toContain(
      'must start with ":"',
    );
    await answerPromptDialog(".fancy");
    expect(tab.session.ui.activeSelector).toBe(".fancy");
    expect(c.querySelector(".selector-custom-input")).toBeNull();

    // Cancelling changes nothing.
    c = await renderPanel();
    addCustom(c);
    await flush();
    await answerPromptDialog(null);
    expect(tab.session.ui.activeSelector).toBe(".fancy");
  });

  test("style.openSelectorMenu opens the Target Line's own menu, and refuses when unrendered", async () => {
    setupTab({});
    // Connected, because the command asks the element whether it is still in the document.
    const host = document.createElement("div");
    document.body.append(host);
    const c = await renderInto(renderStylePanelTemplate({ getCanvasMode: () => "edit" }), host);
    const trigger = c.querySelector("overlay-trigger") as HTMLElement & { open?: string };
    expect(trigger).not.toBeNull();
    openSelectorMenu();
    expect(trigger.open).toBe("click");

    resetSelectorMenu();
    expect(() => openSelectorMenu()).toThrow("needs the Inspector's Style tab rendered");
    host.remove();
  });
});

// ─── Color-scheme layer routing (spec §9.5) ──────────────────────────────────

describe("color-scheme layer routing", () => {
  const SCHEME_MEDIA = { "--dark": "(prefers-color-scheme: dark)", ...MEDIA };

  function setupSchemeTab(
    style: JxStyle | undefined,
    media: Record<string, string> = SCHEME_MEDIA,
  ) {
    resetStudioState();
    const doc = {
      $media: media,
      children: [{ ...(style ? { style } : {}), tagName: "section" }],
      tagName: "div",
    } as unknown as JxMutableNode;
    const tab = resetWorkspaceWithTab(doc);
    tab.session.selection = [["children", 0]];
    return tab;
  }

  test("forced Dark shows the variant segment and routes base-context edits into @--dark", async () => {
    const tab = setupSchemeTab({ "@--dark": { textTransform: "uppercase" }, color: "blue" });
    tab.session.ui.previewColorScheme = "dark";
    const c = await renderPanel();
    expect(segment(c, "scheme")?.textContent).toContain("Dark variant");
    // The scheme block is the active context: its props render, and clearing edits it in place.
    const r = row(c, "textTransform");
    expect(r).not.toBeNull();
    click(r!.querySelector(".set-dot"));
    expect(selectedNode().style?.["@--dark"]).toBeUndefined();
    expect(selectedNode().style?.color).toBe("blue");
  });

  test("the base value shows through as an inherited donor, and the chip goes back to it", async () => {
    const tab = setupSchemeTab({ color: "blue" });
    tab.session.ui.previewColorScheme = "dark";
    tab.session.ui.styleSections = { typography: true };
    const c = await renderPanel();
    expect(chip(c, "color")?.textContent).toContain("from Base");
    click(chip(c, "color"));
    expect(tab.session.ui.previewColorScheme as string).toBe("auto");
  });

  test("Auto keeps base-context editing and shows no variant segment", async () => {
    const tab = setupSchemeTab({ color: "blue" });
    tab.session.ui.previewColorScheme = "auto";
    const c = await renderPanel();
    expect(segment(c, "scheme")).toBeNull();
    click(row(c, "color")!.querySelector(".set-dot"));
    expect(selectedNode().style?.color).toBeUndefined();
  });

  test("a breakpoint tab stays breakpoint-scoped even while a scheme is forced", async () => {
    const tab = setupSchemeTab({ "@sm": { textTransform: "uppercase" }, color: "blue" });
    tab.session.ui.previewColorScheme = "dark";
    tab.session.ui.activeMedia = "sm";
    const c = await renderPanel();
    expect(segment(c, "scheme")).toBeNull();
    click(row(c, "textTransform")!.querySelector(".set-dot"));
    expect(selectedNode().style?.["@sm"]).toBeUndefined();
    expect(selectedNode().style?.color).toBe("blue");
  });

  test("no declared scheme query — forced scheme falls back to base routing", async () => {
    const tab = setupSchemeTab({ color: "blue" }, MEDIA);
    tab.session.ui.previewColorScheme = "dark";
    const c = await renderPanel();
    expect(segment(c, "scheme")).toBeNull();
    click(row(c, "color")!.querySelector(".set-dot"));
    expect(selectedNode().style?.color).toBeUndefined();
  });
});

// ─── Provenance chips (§6.2) ─────────────────────────────────────────────────

describe("provenance chips", () => {
  test("a value set here is an accent dot that clears it", async () => {
    setupTab({ color: "blue" });
    const c = await renderPanel();
    const dot = chip(c, "color")!;
    expect(dot.classList.contains("provenance-chip--set")).toBe(true);
    expect(dot.classList.contains("set-dot")).toBe(true);
    click(dot);
    expect(selectedNode().style?.color).toBeUndefined();
  });

  test("an inherited value names its donor breakpoint and jumps there", async () => {
    const tab = setupTab({ color: "blue" }, { media: true });
    tab.session.ui.activeMedia = "md";
    tab.session.ui.styleSections = { typography: true };
    const c = await renderPanel();
    const inherited = chip(c, "color")!;
    expect(inherited.textContent).toContain("from Base");
    expect(inherited.getAttribute("title")).toContain("click to go there");
    click(inherited);
    expect(tab.session.ui.activeMedia).toBeNull();
  });

  test("a lower breakpoint is named as the donor, not just 'Base'", async () => {
    const tab = setupTab({ "@sm": { color: "red" }, color: "blue" }, { media: true });
    tab.session.ui.activeMedia = "md";
    tab.session.ui.styleSections = { typography: true };
    const c = await renderPanel();
    expect(chip(c, "color")?.textContent).toContain("from Sm");
    click(chip(c, "color"));
    expect(tab.session.ui.activeMedia).toBe("sm");
  });

  test("a ${} value is bound, names its signal and opens it", async () => {
    resetStudioState();
    const doc = {
      children: [{ style: { color: "${state.brand}" }, tagName: "section" }],
      state: { brand: { default: "red" } },
      tagName: "div",
    } as unknown as JxMutableNode;
    const tab = resetWorkspaceWithTab(doc);
    tab.session.selection = [["children", 0]];
    const c = await renderPanel();
    const bound = chip(c, "color")!;
    expect(bound.classList.contains("provenance-chip--bound")).toBe(true);
    expect(bound.textContent).toContain("brand");
    click(bound);
    expect(runMock).toHaveBeenCalledWith("state.selectSignal", { name: "brand" });
  });

  test("an unset property carries no chip at all — absence is the ghost", async () => {
    setupTab({ display: "flex" });
    const c = await renderPanel();
    expect(chip(c, "flexDirection")).toBeNull();
  });
});
describe("selector style editing", () => {
  test("pseudo selector: rows come from the nested block; clearing removes the block", async () => {
    const tab = setupTab({ ":hover": { textTransform: "uppercase" } });
    tab.session.ui.activeSelector = ":hover";
    const c = await renderPanel();
    expect(segment(c, "selector")?.textContent).toContain(":hover");
    // The declared selector is marked in the menu
    const hoverItem = [...c.querySelectorAll(".tl-selector-menu sp-menu-item")].find(
      (m) => m.getAttribute("value") === ":hover",
    );
    expect(hoverItem?.textContent).toContain("●");
    click(row(c, "textTransform")!.querySelector(".set-dot"));
    expect(selectedNode().style).toBeUndefined();
  });

  test("pseudo selector inside a media tab", async () => {
    const tab = setupTab({ "@sm": { ":hover": { textTransform: "lowercase" } } }, { media: true });
    tab.session.ui.activeMedia = "sm";
    tab.session.ui.activeSelector = ":hover";
    const c = await renderPanel();
    click(row(c, "textTransform")!.querySelector(".set-dot"));
    expect(selectedNode().style).toBeUndefined();
  });

  test("tag path selector resolves nested tag styles", async () => {
    const tab = setupTab({ th: { textTransform: "capitalize" } });
    tab.session.ui.activeSelector = "th";
    const c = await renderPanel();
    click(row(c, "textTransform")!.querySelector(".set-dot"));
    expect(selectedNode().style).toBeUndefined();
  });

  test("multi-segment tag path resolves deeply; missing paths yield empty style", async () => {
    const tab = setupTab({ table: { th: { textTransform: "uppercase" } } });
    tab.session.ui.activeSelector = "table th";
    let c = await renderPanel();
    expect(row(c, "textTransform")!.querySelector(".set-dot")).not.toBeNull();

    tab.session.ui.activeSelector = "table td";
    c = await renderPanel();
    // Missing path resolves to an empty style: the row renders with no set-value dot
    expect(row(c, "textTransform")!.querySelector(".set-dot")).toBeNull();
  });

  test("tag path within a media tab", async () => {
    const tab = setupTab({ "@sm": { th: { textTransform: "uppercase" } } }, { media: true });
    tab.session.ui.activeMedia = "sm";
    tab.session.ui.activeSelector = "th";
    const c = await renderPanel();
    click(row(c, "textTransform")!.querySelector(".set-dot"));
    expect(selectedNode().style).toBeUndefined();
  });
});

// ─── Filter bar ──────────────────────────────────────────────────────────────

describe("filter bar", () => {
  test("the filter input updates session ui, and the Active toggle is gone", async () => {
    const tab = setupTab({});
    const c = await renderPanel();
    fire(c.querySelector(".style-filter-input"), "input", "flex");
    expect(tab.session.ui.styleFilter).toBe("flex");
    // Retired by the heading's provenance dots (§6.2): it existed only because a closed section
    // Could not say whether anything inside it was set.
    expect(c.querySelector(".style-filter-toggle")).toBeNull();
  });

  test("text filter shows matching rows only and drops empty sections", async () => {
    const tab = setupTab({ display: "flex" });
    tab.session.ui.styleFilter = "flex";
    const c = await renderPanel();
    expect(row(c, "flexDirection")).not.toBeNull();
    expect(row(c, "display")).toBeNull();
    // Sections with no matches are dropped while filtering
    expect(accordionItem(c, "Size")).toBeUndefined();
  });

  test("filter matches against the human-readable label", async () => {
    const tab = setupTab({ display: "flex" });
    tab.session.ui.styleFilter = "wrap"; // Matches label "Flex Wrap", not camelCase prop name
    const c = await renderPanel();
    expect(row(c, "flexWrap")).not.toBeNull();
    expect(row(c, "display")).toBeNull();
  });

  test("a section heading tallies what is set, inherited and bound inside it", async () => {
    const tab = setupTab({ display: "flex", paddingTop: "4px" }, { media: true });
    tab.session.ui.activeMedia = "md";
    const c = await renderPanel();
    const layout = accordionItem(c, "Layout");
    const dots = layout!.querySelector(".provenance-dots");
    expect(dots).not.toBeNull();
    // Nothing is set on @md, so the tally is what shows through from Base — which is exactly the
    // Question the retired "Active" toggle could only answer by hiding everything else.
    expect(dots!.getAttribute("title")).toContain("inherited");
  });
});

// ─── Shorthand rows ──────────────────────────────────────────────────────────

describe("shorthand rows", () => {
  test("set longhand auto-expands and seeds the shorthand placeholder", async () => {
    setupTab({ paddingTop: "4px" });
    const c = await renderPanel();
    const header = row(c, "padding")!.querySelector(".style-shorthand-header sp-textfield");
    expect(header!.getAttribute("placeholder")).toBe("4px 0 0 0");
    const children = c.querySelectorAll(".style-row--child");
    expect(children.length).toBe(4);
  });

  test("typing a shorthand value clears longhands and sets the shorthand", async () => {
    setupTab({ paddingTop: "4px" });
    const c = await renderPanel();
    fire(row(c, "padding")!.querySelector(".style-shorthand-header sp-textfield"), "input", "8px");
    expect(selectedNode().style?.padding).toBe("8px");
    expect(selectedNode().style?.paddingTop).toBeUndefined();
  });

  test("shorthand-only value starts collapsed; toggle expands child rows", async () => {
    const tab = setupTab({ padding: "1px 2px 3px 4px" });
    let c = await renderPanel();
    expect(c.querySelectorAll(".style-row--child").length).toBe(0);
    click(row(c, "padding")!.querySelector("sp-action-button"));
    expect(tab.session.ui.styleShorthands.padding).toBe(true);
    c = await renderPanel();
    const childProps = [...c.querySelectorAll<HTMLElement>(".style-row--child")].map(
      (r) => r.dataset.prop,
    );
    expect(childProps).toEqual(["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]);
  });

  test("clearing one expanded longhand recompresses the shorthand", async () => {
    const tab = setupTab({ padding: "1px 2px 3px 4px" });
    tab.session.ui.styleShorthands = { padding: true };
    const c = await renderPanel();
    click(c.querySelector('.style-row--child[data-prop="paddingTop"] .set-dot'));
    expect(selectedNode().style?.padding).toBe("0 2px 3px 4px");
  });

  test("clearing a longhand also folds other explicit longhands into the shorthand", async () => {
    const tab = setupTab({ padding: "1px 2px 3px 4px", paddingLeft: "5px" });
    tab.session.ui.styleShorthands = { padding: true };
    const c = await renderPanel();
    click(c.querySelector('.style-row--child[data-prop="paddingTop"] .set-dot'));
    expect(selectedNode().style?.padding).toBe("0 2px 3px 5px");
    expect(selectedNode().style?.paddingLeft).toBeUndefined();
  });

  test("editing a longhand clears other explicit longhands before recommitting", async () => {
    const tab = setupTab({ border: "1px solid red", borderColor: "blue" });
    tab.session.ui.styleShorthands = { border: true };
    const c = await renderPanel();
    const styleChild = c.querySelector('.style-row--child[data-prop="borderStyle"]');
    fire(styleChild!.querySelector("jx-value-selector"), "change", "dotted");
    expect(selectedNode().style?.border).toBe("1px dotted blue");
    expect(selectedNode().style?.borderColor).toBeUndefined();
  });

  test("shorthand set-dot clears the shorthand and all set longhands", async () => {
    setupTab({ padding: "4px", paddingLeft: "2px" });
    const c = await renderPanel();
    click(row(c, "padding")!.querySelector(".set-dot"));
    expect(selectedNode().style).toBeUndefined();
  });

  test("border-side shorthand expands into width/style/color and recommits on child edit", async () => {
    const tab = setupTab({ border: "1px solid red" });
    tab.session.ui.styleShorthands = { border: true };
    const c = await renderPanel();
    const styleChild = c.querySelector('.style-row--child[data-prop="borderStyle"]');
    expect(styleChild).not.toBeNull();
    fire(styleChild!.querySelector("jx-value-selector"), "change", "dashed");
    expect(selectedNode().style?.border).toBe("1px dashed red");
  });

  test("clearing a border-side child drops the empty token", async () => {
    const tab = setupTab({ border: "1px solid red" });
    tab.session.ui.styleShorthands = { border: true };
    const c = await renderPanel();
    click(c.querySelector('.style-row--child[data-prop="borderStyle"] .set-dot'));
    expect(selectedNode().style?.border).toBe("1px red");
  });

  test("inherited base values surface as placeholders on higher breakpoints", async () => {
    const tab = setupTab({ padding: "9px" }, { media: true });
    tab.session.ui.activeMedia = "md";
    tab.session.ui.styleSections = { spacing: true };
    let c = await renderPanel();
    let header = row(c, "padding")!.querySelector(".style-shorthand-header sp-textfield");
    expect(header!.getAttribute("placeholder")).toBe("9px");

    const tab2 = setupTab({ paddingTop: "3px" }, { media: true });
    tab2.session.ui.activeMedia = "md";
    tab2.session.ui.styleSections = { spacing: true };
    c = await renderPanel();
    header = row(c, "padding")!.querySelector(".style-shorthand-header sp-textfield");
    expect(header!.getAttribute("placeholder")).toBe("3px 0 0 0");
  });
});

// ─── Section accordion ───────────────────────────────────────────────────────

describe("section accordion", () => {
  test("open section heading dot clears every set prop including shorthand longhands", async () => {
    setupTab({ padding: "4px", paddingTop: "1px" });
    const c = await renderPanel();
    const spacing = accordionItem(c, "Spacing");
    click(spacing!.querySelector(".provenance-dots .set-dot"));
    expect(selectedNode().style).toBeUndefined();
  });

  test("toggling an open section persists the open state", async () => {
    const tab = setupTab({ display: "flex" });
    const c = await renderPanel();
    toggleAccordion(accordionItem(c, "Layout"), false);
    expect(tab.session.ui.styleSections.layout).toBe(false);
  });

  test("closed section with object-valued props shows a clear-all dot", async () => {
    const tab = setupTab({
      ":hover": {
        display: { unexpected: true } as unknown as string,
        paddingTop: { unexpected: true } as unknown as string,
      },
    });
    tab.session.ui.activeSelector = ":hover";
    let c = await renderPanel();
    const layout = accordionItem(c, "Layout");
    expect(row(c, "display")).toBeNull(); // Section is closed → no rows
    click(layout!.querySelector(".provenance-dots .set-dot"));
    const hover = selectedNode().style?.[":hover"] as Record<string, unknown>;
    expect(hover.display).toBeUndefined();
    expect(hover.paddingTop).toBeDefined();

    c = await renderPanel();
    const spacing = accordionItem(c, "Spacing");
    click(spacing!.querySelector(".provenance-dots .set-dot"));
    expect(selectedNode().style).toBeUndefined();
  });

  test("toggling a closed section open persists the state", async () => {
    const tab = setupTab({});
    const c = await renderPanel();
    toggleAccordion(accordionItem(c, "Border"), true);
    expect(tab.session.ui.styleSections.border).toBe(true);
  });
});

// ─── Custom section ──────────────────────────────────────────────────────────

describe("custom section", () => {
  test("unknown props render as key/value rows; value edits commit", async () => {
    setupTab({ foo: "bar" });
    const c = await renderPanel();
    const kvKey = c.querySelector(".kv-row .kv-key") as HTMLInputElement;
    expect(kvKey.value).toBe("foo");
    fire(c.querySelector(".kv-row .kv-val"), "input", "baz");
    expect(selectedNode().style?.foo).toBe("baz");
  });

  test("renaming the key moves the value; same or empty name is a no-op", async () => {
    const tab = setupTab({ foo: "bar" });
    let c = await renderPanel();
    fire(c.querySelector(".kv-row .kv-key"), "change", "qux");
    expect(selectedNode().style?.foo).toBeUndefined();
    expect(selectedNode().style?.qux).toBe("bar");

    c = await renderPanel();
    const before = tab.history.snapshots.length;
    fire(c.querySelector(".kv-row .kv-key"), "change", "qux");
    fire(c.querySelector(".kv-row .kv-key"), "change", "  ");
    expect(tab.history.snapshots.length).toBe(before);
    expect(selectedNode().style?.qux).toBe("bar");
  });

  test("clear button removes the custom prop", async () => {
    setupTab({ foo: "bar" });
    const c = await renderPanel();
    click(c.querySelector(".kv-row sp-action-button"));
    expect(selectedNode().style).toBeUndefined();
  });

  test("Enter in the new-property field seeds the CSS initial value", async () => {
    setupTab({ foo: "bar" });
    const c = await renderPanel();
    const adder = c.querySelector('sp-textfield[placeholder="Property name…"]') as HTMLInputElement;
    adder.value = "zoom";
    adder.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(selectedNode().style?.zoom).toBe("1");
    expect(adder.value).toBe("");
  });

  test("new-property field ignores empty names and non-Enter keys", async () => {
    const tab = setupTab({ foo: "bar" });
    const c = await renderPanel();
    const adder = c.querySelector('sp-textfield[placeholder="Property name…"]') as HTMLInputElement;
    const before = tab.history.snapshots.length;
    adder.value = "zoom";
    adder.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    adder.value = "   ";
    adder.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(tab.history.snapshots.length).toBe(before);
  });

  test("toggle persists the Custom section open state", async () => {
    const tab = setupTab({});
    const c = await renderPanel();
    toggleAccordion(accordionItem(c, "Custom"), true);
    expect(tab.session.ui.styleSections.other).toBe(true);
  });
});

// ─── Relative styling (nested rules) ─────────────────────────────────────────

describe("relative styling section", () => {
  function nestedTab() {
    const tab = setupTab({ table: { textTransform: "uppercase", th: { color: "blue" } } });
    tab.session.ui.activeSelector = "table";
    return tab;
  }

  test("nested rule buttons navigate via selectStylebookTag with a compound path", async () => {
    nestedTab();
    const c = await renderPanel();
    const section = accordionItem(c, "Relative Styling");
    expect(section).toBeTruthy();
    const ruleBtn = [...section!.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "th",
    );
    click(ruleBtn);
    expect(selectStylebookTagMock).toHaveBeenCalledWith("table th", undefined, {
      panCanvas: true,
    });
  });

  test("delete button removes the nested rule", async () => {
    nestedTab();
    const c = await renderPanel();
    const section = accordionItem(c, "Relative Styling");
    click(section!.querySelector("sp-action-button"));
    const table = selectedNode().style?.table as Record<string, unknown>;
    expect(table.th).toBeUndefined();
    expect(table.textTransform).toBe("uppercase");
  });

  test("+ Add opens a selector dialog and creates an empty rule; blank or cancel is ignored", async () => {
    nestedTab();

    /** Click the section's "+ Add" and let the prompt dialog render. */
    async function clickAdd(container: HTMLElement) {
      const section = accordionItem(container, "Relative Styling");
      click([...section!.querySelectorAll("button")].find((b) => b.textContent?.includes("+ Add")));
      await flush();
    }

    let c = await renderPanel();
    await clickAdd(c);

    // A Spectrum dialog, not a native prompt.
    expect(topDialog()).not.toBeNull();
    expect(topDialog()!.getAttribute("headline")).toBe("Add Nested Selector");
    expect(topDialog()!.getAttribute("confirm-label")).toBe("Add");

    await answerPromptDialog(" td ");
    const table = selectedNode().style?.table as Record<string, unknown>;
    expect(table.td).toEqual({});

    // Cancelling adds nothing.
    c = await renderPanel();
    await clickAdd(c);
    await answerPromptDialog(null);

    // A blank selector is rejected in place, leaving the dialog open and the style untouched.
    c = await renderPanel();
    await clickAdd(c);
    await answerPromptDialog("   ");
    expect(topDialog()).not.toBeNull();
    expect(topDialog()!.querySelector("sp-help-text")?.textContent).toContain("Enter a selector.");
    await answerPromptDialog(null);

    expect(Object.keys(selectedNode().style?.table as Record<string, unknown>).toSorted()).toEqual(
      ["td", "textTransform", "th"].toSorted(),
    );
  });

  test("absent in base mode and toggle persists nested open state", async () => {
    const tab = setupTab({ display: "flex" });
    let c = await renderPanel();
    expect(accordionItem(c, "Relative Styling")).toBeUndefined();

    tab.session.ui.activeSelector = "table";
    tab.session.selection = [["children", 0]];
    const tab2 = nestedTab();
    c = await renderPanel();
    toggleAccordion(accordionItem(c, "Relative Styling"), true);
    expect(tab2.session.ui.styleSections.nested).toBe(true);
  });
});

// ─── _fieldRow helper ────────────────────────────────────────────────────────

describe("_fieldRow", () => {
  test("text type renders a textfield with the live value", async () => {
    const c = await renderInto(_fieldRow("Name", "text", "hello", () => {}, "dl-1"));
    const field = c.querySelector("sp-textfield") as HTMLInputElement;
    expect(field.value).toBe("hello");
    expect(c.querySelector("sp-field-label")?.textContent).toContain("Name");
  });

  test("textarea type renders a multiline textfield", async () => {
    const c = await renderInto(_fieldRow("Body", "textarea", "line", () => {}, "dl-2"));
    expect(c.querySelector("sp-textfield[multiline]")).not.toBeNull();
  });

  test("checkbox type commits the checked state synchronously", async () => {
    const seen: (string | boolean)[] = [];
    const c = await renderInto(_fieldRow("Flag", "checkbox", "yes", (v) => seen.push(v), "dl-3"));
    const box = c.querySelector("sp-checkbox") as unknown as HTMLElement & { checked: boolean };
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual([true]);
  });
});
