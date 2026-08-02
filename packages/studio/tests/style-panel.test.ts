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

const { _fieldRow, renderStylePanelTemplate } = await import("../src/panels/style-panel");
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
  tab.session.selection = ["children", 0];
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
    tab.session.selection = ["children", 9];
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
  test("renders header and merges site style into effective style", async () => {
    setupTab({});
    resetStudioState({ projectConfig: { style: { textAlign: "center" } } });
    shell.stylebook.selection = "h1";
    const c = await renderPanel("stylebook");
    expect(c.querySelector(".stylebook-style-header")?.textContent).toContain("h1");
    const r = row(c, "textAlign");
    expect(r).not.toBeNull();
    expect(r!.querySelector(".set-dot")).not.toBeNull();
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
  test("style rows cycle between literal and template only (no $ref in JxStyle)", async () => {
    setupTab({ display: "flex" });
    const c = await renderPanel();
    const mode = row(c, "display")!.querySelector(".style-row-label .dynamic-slot-mode")!;
    expect(mode).not.toBeNull();
    expect(mode.textContent!.trim()).toBe("abc");
    expect(mode.getAttribute("title")).toBe("Field mode: static — click for template literal");
  });

  test("switching to template mode seeds a state-based template string", async () => {
    resetStudioState();
    const doc = {
      children: [{ style: { display: "flex" }, tagName: "section" }],
      state: { mode: { default: "grid" } },
      tagName: "div",
    } as unknown as JxMutableNode;
    const tab = resetWorkspaceWithTab(doc);
    tab.session.selection = ["children", 0];
    const c = await renderPanel();
    click(row(c, "display")!.querySelector(".dynamic-slot-mode"));
    expect(selectedNode().style?.display).toBe("${state.mode}");
  });

  test("template-valued style renders the ${} textfield and commits edits", async () => {
    setupTab({ display: "${state.mode}" });
    const c = await renderPanel();
    const r = row(c, "display")!;
    expect(r.querySelector(".dynamic-slot-mode")!.textContent!.trim()).toBe("${}");
    const tf = r.querySelector("sp-textfield") as HTMLInputElement;
    expect(tf.value).toBe("${state.mode}");
    fire(tf, "change", "${state.other}");
    expect(selectedNode().style?.display).toBe("${state.other}");
  });

  test("de-escalating a template value to literal clears the property", async () => {
    setupTab({ display: "${state.mode}" });
    const c = await renderPanel();
    click(row(c, "display")!.querySelector(".dynamic-slot-mode"));
    expect(selectedNode().style).toBeUndefined();
  });

  test("cycling back to literal restores the stashed style value", async () => {
    setupTab({ display: "flex" });
    let c = await renderPanel();
    click(row(c, "display")!.querySelector(".dynamic-slot-mode"));
    expect(selectedNode().style?.display).toBe("${}");

    c = await renderPanel();
    click(row(c, "display")!.querySelector(".dynamic-slot-mode"));
    expect(selectedNode().style?.display).toBe("flex");
  });
});

// ─── Media tabs ──────────────────────────────────────────────────────────────

describe("media tabs", () => {
  test("absent without $media; present with breakpoint labels", async () => {
    setupTab({});
    const noMedia = await renderPanel();
    expect(noMedia.querySelector("sp-tabs")).toBeNull();

    setupTab({}, { media: true });
    const c = await renderPanel();
    const tabsEl = c.querySelector("sp-tabs");
    expect(tabsEl).not.toBeNull();
    const labels = [...c.querySelectorAll("sp-tab")].map((t) => t.getAttribute("label"));
    expect(labels).toEqual(["Base", "Sm", "Md"]);
  });

  test("changing the selected tab updates activeMedia, base maps to null", async () => {
    const tab = setupTab({}, { media: true });
    let c = await renderPanel();
    const tabsEl = c.querySelector("sp-tabs") as HTMLElement & { selected: string };
    tabsEl.selected = "sm";
    fire(tabsEl, "change");
    expect(tab.session.ui.activeMedia).toBe("sm");

    c = await renderPanel();
    const tabsEl2 = c.querySelector("sp-tabs") as HTMLElement & { selected: string };
    // Re-selecting the current value is a no-op branch
    tabsEl2.selected = "sm";
    fire(tabsEl2, "change");
    expect(tab.session.ui.activeMedia).toBe("sm");

    tabsEl2.selected = "base";
    fire(tabsEl2, "change");
    expect(tab.session.ui.activeMedia).toBeNull();
  });

  test("media tab edits write into the @media block and clean up when emptied", async () => {
    const tab = setupTab({ "@sm": { textTransform: "uppercase" }, color: "blue" }, { media: true });
    tab.session.ui.activeMedia = "sm";
    const c = await renderPanel();
    const r = row(c, "textTransform");
    expect(r).not.toBeNull();
    click(r!.querySelector(".set-dot"));
    expect(selectedNode().style?.["@sm"]).toBeUndefined();
    expect(selectedNode().style?.color).toBe("blue");
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
    tab.session.selection = ["children", 0];
    return tab;
  }

  test("forced Dark shows the variant badge and routes base-context edits into @--dark", async () => {
    const tab = setupSchemeTab({ "@--dark": { textTransform: "uppercase" }, color: "blue" });
    tab.session.ui.previewColorScheme = "dark";
    const c = await renderPanel();
    expect(c.querySelector(".style-scheme-badge")?.textContent).toContain("Dark variant");
    // The scheme block is the active context: its props render, and clearing edits it in place.
    const r = row(c, "textTransform");
    expect(r).not.toBeNull();
    click(r!.querySelector(".set-dot"));
    expect(selectedNode().style?.["@--dark"]).toBeUndefined();
    expect(selectedNode().style?.color).toBe("blue");
  });

  test("Auto keeps base-context editing and shows no badge", async () => {
    const tab = setupSchemeTab({ color: "blue" });
    tab.session.ui.previewColorScheme = "auto";
    const c = await renderPanel();
    expect(c.querySelector(".style-scheme-badge")).toBeNull();
    click(row(c, "color")!.querySelector(".set-dot"));
    expect(selectedNode().style?.color).toBeUndefined();
  });

  test("a breakpoint tab stays breakpoint-scoped even while a scheme is forced", async () => {
    const tab = setupSchemeTab({ "@sm": { textTransform: "uppercase" }, color: "blue" });
    tab.session.ui.previewColorScheme = "dark";
    tab.session.ui.activeMedia = "sm";
    const c = await renderPanel();
    expect(c.querySelector(".style-scheme-badge")).toBeNull();
    click(row(c, "textTransform")!.querySelector(".set-dot"));
    expect(selectedNode().style?.["@sm"]).toBeUndefined();
    expect(selectedNode().style?.color).toBe("blue");
  });

  test("no declared scheme query — forced scheme falls back to base routing", async () => {
    const tab = setupSchemeTab({ color: "blue" }, MEDIA);
    tab.session.ui.previewColorScheme = "dark";
    const c = await renderPanel();
    expect(c.querySelector(".style-scheme-badge")).toBeNull();
    click(row(c, "color")!.querySelector(".set-dot"));
    expect(selectedNode().style?.color).toBeUndefined();
  });
});

// ─── Selector modes ──────────────────────────────────────────────────────────

describe("selector style editing", () => {
  test("pseudo selector: rows come from the nested block; clearing removes the block", async () => {
    const tab = setupTab({ ":hover": { textTransform: "uppercase" } });
    tab.session.ui.activeSelector = ":hover";
    const c = await renderPanel();
    const picker = c.querySelector(".selector-select") as HTMLInputElement;
    expect(picker.value).toBe(":hover");
    // Existing selector is marked in the menu
    const hoverItem = [...c.querySelectorAll("sp-menu-item")].find((m) =>
      m.textContent?.includes(":hover"),
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

// ─── Selector picker ─────────────────────────────────────────────────────────

describe("selector picker", () => {
  test("changing the picker sets and clears the active selector", async () => {
    const tab = setupTab({});
    const c = await renderPanel();
    const picker = c.querySelector(".selector-select") as HTMLInputElement;
    fire(picker, "change", ":focus");
    expect(tab.session.ui.activeSelector).toBe(":focus");
    fire(picker, "change", "__base__");
    expect(tab.session.ui.activeSelector).toBeNull();
  });

  test("non-common existing and active selectors appear as extra menu items", async () => {
    const tab = setupTab({ "&.active": { color: "red" } });
    tab.session.ui.activeSelector = "&.custom";
    const c = await renderPanel();
    const values = [...c.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value"));
    expect(values).toContain("&.active");
    expect(values).toContain("&.custom");
  });

  test("add-custom flow commits a valid selector on Enter", async () => {
    const tab = setupTab({});
    const c = await renderPanel();
    const picker = c.querySelector(".selector-select") as HTMLElement & { value: string };
    fire(picker, "change", "__add_custom__");
    const inp = c.querySelector(".selector-custom-input") as HTMLInputElement;
    expect(inp).not.toBeNull();
    expect(picker.style.display).toBe("none");
    inp.value = ".fancy";
    inp.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(tab.session.ui.activeSelector).toBe(".fancy");
    expect(c.querySelector(".selector-custom-input")).toBeNull();
    expect(picker.style.display).toBe("");
    // Second keydown after finish is guarded
    inp.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(tab.session.ui.activeSelector).toBe(".fancy");
  });

  test("add-custom flow: Escape cancels, invalid selectors are rejected", async () => {
    const tab = setupTab({});
    let c = await renderPanel();
    let picker = c.querySelector(".selector-select") as HTMLElement;
    fire(picker, "change", "__add_custom__");
    let inp = c.querySelector(".selector-custom-input") as HTMLInputElement;
    inp.value = ".whatever";
    inp.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(tab.session.ui.activeSelector).toBeNull();

    c = await renderPanel();
    picker = c.querySelector(".selector-select") as HTMLElement;
    fire(picker, "change", "__add_custom__");
    inp = c.querySelector(".selector-custom-input") as HTMLInputElement;
    inp.value = "notASelector";
    inp.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(tab.session.ui.activeSelector).toBeNull();
  });

  test("add-custom flow: blur accepts non-empty input, cancels empty input", async () => {
    const tab = setupTab({});
    let c = await renderPanel();
    fire(c.querySelector(".selector-select"), "change", "__add_custom__");
    let inp = c.querySelector(".selector-custom-input") as HTMLInputElement;
    inp.value = "[disabled]";
    inp.dispatchEvent(new Event("blur"));
    expect(tab.session.ui.activeSelector).toBe("[disabled]");

    tab.session.ui.activeSelector = null;
    c = await renderPanel();
    fire(c.querySelector(".selector-select"), "change", "__add_custom__");
    inp = c.querySelector(".selector-custom-input") as HTMLInputElement;
    inp.value = "   ";
    inp.dispatchEvent(new Event("blur"));
    expect(tab.session.ui.activeSelector).toBeNull();
  });
});

// ─── Filter bar ──────────────────────────────────────────────────────────────

describe("filter bar", () => {
  test("filter input and active toggle update session ui", async () => {
    const tab = setupTab({});
    const c = await renderPanel();
    fire(c.querySelector(".style-filter-input"), "input", "flex");
    expect(tab.session.ui.styleFilter).toBe("flex");
    click(c.querySelector(".style-filter-toggle"));
    expect(tab.session.ui.styleFilterActive).toBe(true);
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

  test("active-only filter keeps set props and shorthands with set longhands", async () => {
    const tab = setupTab({ display: "flex", paddingTop: "4px" });
    tab.session.ui.styleFilterActive = true;
    const c = await renderPanel();
    expect(row(c, "display")).not.toBeNull();
    expect(row(c, "padding")).not.toBeNull();
    expect(row(c, "margin")).toBeNull();
    expect(row(c, "flexDirection")).toBeNull();
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
    click(spacing!.querySelector(".set-dot--section"));
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
    click(layout!.querySelector(".set-dot--section"));
    const hover = selectedNode().style?.[":hover"] as Record<string, unknown>;
    expect(hover.display).toBeUndefined();
    expect(hover.paddingTop).toBeDefined();

    c = await renderPanel();
    const spacing = accordionItem(c, "Spacing");
    click(spacing!.querySelector(".set-dot--section"));
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
    tab.session.selection = ["children", 0];
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
