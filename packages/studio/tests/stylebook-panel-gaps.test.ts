/**
 * Gap coverage for src/panels/stylebook-panel.ts — full stylebook mode rendering, overlays,
 * selection, panel events and style refresh.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import {
  refreshStylebookStyles,
  renderComponentPreview,
  renderStylebookElementsIntoCanvas,
  renderStylebookMode,
  renderStylebookOverlays,
  selectStylebookTag,
} from "../src/panels/stylebook-panel";
import { canvasPanels, initShellRefs } from "../src/store";
import { closeAllTabs } from "../src/workspace/workspace";
import { componentRegistry } from "../src/files/components";
import { view } from "../src/view";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CanvasPanel } from "../src/types";

// ─── Shell + fake panel scaffolding ───────────────────────────────────────────

function setupShell() {
  document.body.innerHTML = "";
  for (const id of [
    "canvas-wrap",
    "activity-bar",
    "left-panel",
    "right-panel",
    "toolbar",
    "statusbar",
  ]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
}

const scrollTo = mock((_opts: unknown) => {});

function makePanel(mediaName: string | null, width?: number | null) {
  const element = document.createElement("div");
  element.className = "canvas-panel";
  const viewport = document.createElement("div");
  const canvas = document.createElement("div");
  const overlay = document.createElement("div");
  const overlayClk = document.createElement("div");
  const dropLine = document.createElement("div");
  element.append(viewport);
  viewport.append(canvas, overlay, overlayClk, dropLine);
  const panel = {
    _width: width ?? null,
    canvas,
    dropLine,
    element,
    mediaName,
    overlay,
    overlayClk,
    ready: false,
    scrollContainer: { scrollTo } as unknown as HTMLElement,
    viewport,
  };
  return panel as unknown as CanvasPanel;
}

const panelTemplateCalls: unknown[][] = [];
const ctx = {
  applyTransform: mock(() => {}),
  canvasPanelTemplate: (
    mediaName: string | null,
    label: string | null,
    fullWidth: boolean,
    width?: number | null,
  ) => {
    panelTemplateCalls.push([mediaName, label, fullWidth, width]);
    const panel = makePanel(mediaName, width);
    return { panel, tpl: html`${(panel as { element?: HTMLElement }).element}` };
  },
  effectiveZoom: () => 1,
  observeCenterUntilStable: mock(() => {}),
  overlayBoxDescriptor: mock((_el: Element, type: string, _panel: CanvasPanel) => ({
    cls: `overlay-box overlay-${type}`,
    height: "20px",
    left: "1px",
    top: "2px",
    width: "100px",
  })),
  renderZoomIndicator: mock(() => {}),
  updateActivePanelHeaders: mock(() => {}),
} as never as Parameters<typeof renderStylebookMode>[0];

const ctxMocks = ctx as unknown as Record<string, ReturnType<typeof mock>>;

function makeTab(doc: Record<string, unknown> = {}) {
  return resetWorkspaceWithTab({ children: [], tagName: "div", ...doc } as JxMutableNode);
}

const realElementsFromPoint = (document as unknown as Record<string, unknown>).elementsFromPoint;
let pointElements: Element[] = [];

beforeEach(() => {
  setupShell();
  resetStudioState();
  canvasPanels.length = 0;
  componentRegistry.length = 0;
  panelTemplateCalls.length = 0;
  scrollTo.mockClear();
  for (const fn of Object.values(ctxMocks)) {
    if (typeof fn?.mockClear === "function") {
      fn.mockClear();
    }
  }
  pointElements = [];
  (document as unknown as Record<string, unknown>).elementsFromPoint = () => pointElements;
});

afterEach(() => {
  (document as unknown as Record<string, unknown>).elementsFromPoint = realElementsFromPoint;
});

// ─── Pre-init guard (must run before any renderStylebookMode call) ────────────

describe("renderStylebookOverlays before mode init", () => {
  test("is a no-op while the stylebook ctx is unset", () => {
    makeTab();
    canvasPanels.push(makePanel(null));
    expect(() => {
      renderStylebookOverlays();
    }).not.toThrow();
    expect(canvasPanels[0].overlay.children.length).toBe(0);
  });
});

// ─── renderStylebookMode ──────────────────────────────────────────────────────

describe("renderStylebookMode", () => {
  test("renders a single full-width panel when no media is defined", () => {
    makeTab({ style: { h1: { color: "red" } } });
    renderStylebookMode(ctx);

    expect(panelTemplateCalls).toEqual([[null, null, true, undefined]]);
    expect(canvasPanels.length).toBe(1);
    const [panel] = canvasPanels;
    expect(panel.canvas.classList.contains("sb-canvas")).toBe(true);
    const card = panel.canvas.querySelector(".element-card");
    expect(card).not.toBeNull();
    const h1 = panel.canvas.querySelector("h1") as HTMLElement;
    expect(h1.style.color).toBe("red");
    expect(h1.style.pointerEvents).toBe("none");
    expect(ctxMocks.applyTransform).toHaveBeenCalled();
    expect(ctxMocks.observeCenterUntilStable).toHaveBeenCalled();
    expect(ctxMocks.renderZoomIndicator).toHaveBeenCalled();
    expect(ctxMocks.updateActivePanelHeaders).not.toHaveBeenCalled();
    expect(view.panzoomWrap).not.toBeNull();
  });

  test("renders a labelled base panel when only a base width is defined", () => {
    makeTab({ $media: { "--": "480px" } });
    renderStylebookMode(ctx);
    expect(panelTemplateCalls).toEqual([["base", "Base (480px)", false, 480]]);
  });

  test("renders one panel per breakpoint with active media overrides", () => {
    makeTab({
      $media: { "--": "320px", md: "(min-width: 768px)" },
      style: { h1: { "@md": { color: "blue" }, color: "red" } },
    });
    renderStylebookMode(ctx);

    expect(panelTemplateCalls).toEqual([
      ["base", "Base (320px)", false, 320],
      ["md", "Md (768px)", false, 768],
    ]);
    expect(canvasPanels.length).toBe(2);
    const baseH1 = canvasPanels[0].canvas.querySelector("h1") as HTMLElement;
    const mdH1 = canvasPanels[1].canvas.querySelector("h1") as HTMLElement;
    expect(baseH1.style.color).toBe("red");
    expect(mdH1.style.color).toBe("blue");
    expect(ctxMocks.updateActivePanelHeaders).toHaveBeenCalled();
  });

  test("filter input updates session ui", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    const input = document.querySelector("#canvas-wrap .sb-chrome input") as HTMLInputElement;
    input.value = "h1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(tab.session.ui.stylebookFilter).toBe("h1");
  });

  test("customized toggle flips the session flag and gets active class", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    const btn = document.querySelector("#canvas-wrap .sb-chrome button") as HTMLButtonElement;
    expect(btn.classList.contains("active")).toBe(false);
    btn.click();
    expect(tab.session.ui.stylebookCustomizedOnly).toBe(true);

    canvasPanels.length = 0;
    renderStylebookMode(ctx);
    const btn2 = document.querySelector("#canvas-wrap .sb-chrome button") as HTMLButtonElement;
    expect(btn2.classList.contains("active")).toBe(true);
    btn2.click();
    expect(tab.session.ui.stylebookCustomizedOnly).toBe(false);
  });

  test("applies the stylebook filter from session state", () => {
    const tab = makeTab();
    tab.session.ui.stylebookFilter = "blockquote";
    renderStylebookMode(ctx);
    const [{ canvas }] = canvasPanels;
    expect(canvas.querySelector("blockquote")).not.toBeNull();
    expect(canvas.querySelector("h1")).toBeNull();
  });
});

// ─── renderStylebookElementsIntoCanvas filters ────────────────────────────────

describe("renderStylebookElementsIntoCanvas filtering", () => {
  test("customizedOnly keeps only styled tags", () => {
    const canvasEl = document.createElement("div");
    renderStylebookElementsIntoCanvas(canvasEl, { h1: { color: "red" } }, "", true, null);
    expect(canvasEl.querySelector("h1")).not.toBeNull();
    expect(canvasEl.querySelector("p")).toBeNull();
  });

  test("customizedOnly recognises styles nested under top-level @media", () => {
    const canvasEl = document.createElement("div");
    renderStylebookElementsIntoCanvas(
      canvasEl,
      { "@md": { p: { color: "blue" } } },
      "",
      true,
      null,
    );
    expect(canvasEl.querySelector("p")).not.toBeNull();
    expect(canvasEl.querySelector("h1")).toBeNull();
  });

  test("customizedOnly with no styles shows empty state", () => {
    const canvasEl = document.createElement("div");
    renderStylebookElementsIntoCanvas(canvasEl, {}, "", true, null);
    expect(canvasEl.textContent).toContain("No customized elements");
  });

  test("unmatched filter shows empty state", () => {
    const canvasEl = document.createElement("div");
    renderStylebookElementsIntoCanvas(canvasEl, {}, "zzz-not-a-tag", false, null);
    expect(canvasEl.textContent).toContain("No matching elements");
  });

  test("filter matches section labels too", () => {
    const canvasEl = document.createElement("div");
    renderStylebookElementsIntoCanvas(canvasEl, {}, "headings", false, null);
    expect(canvasEl.querySelector("h1")).not.toBeNull();
    expect(canvasEl.querySelector("p")).toBeNull();
  });

  test("renders custom component cards with async previews", async () => {
    componentRegistry.push({ source: "npm", tagName: "x-sb-unregistered" } as never);
    const canvasEl = document.createElement("div");
    renderStylebookElementsIntoCanvas(canvasEl, {}, "", false, null);
    expect(canvasEl.textContent).toContain("<x-sb-unregistered>");
    await flush();
    // Unregistered npm component falls back to a placeholder preview
    const preview = [...canvasEl.querySelectorAll(".element-card-preview")].at(-1);
    expect(preview?.textContent).toBe("<x-sb-unregistered>");
  });

  test("filters components by tag name and customization", () => {
    componentRegistry.push(
      { source: "npm", tagName: "x-keep" } as never,
      {
        source: "npm",
        tagName: "x-drop",
      } as never,
    );
    const canvasEl = document.createElement("div");
    renderStylebookElementsIntoCanvas(canvasEl, {}, "x-keep", false, null);
    expect(canvasEl.textContent).toContain("<x-keep>");
    expect(canvasEl.textContent).not.toContain("<x-drop>");

    const canvasEl2 = document.createElement("div");
    renderStylebookElementsIntoCanvas(canvasEl2, { "x-drop": { color: "red" } }, "", true, null);
    expect(canvasEl2.textContent).toContain("<x-drop>");
    expect(canvasEl2.textContent).not.toContain("<x-keep>");
  });
});

// ─── buildStylebookElement via mode render (media wraps selector) ─────────────

describe("renderStylebookMode top-level @media styles", () => {
  test("applies media-wrapped tag styles when building elements", () => {
    makeTab({
      $media: { "--": "320px", md: "(min-width: 768px)" },
      style: {
        "@--": { h1: { color: "never" } },
        "@md": { blockquote: { p: { color: "navy" } }, h1: { color: "orange" } },
        "@xl": { h1: { color: "never" } },
      },
    });
    renderStylebookMode(ctx);
    const baseH1 = canvasPanels[0].canvas.querySelector("h1") as HTMLElement;
    const mdH1 = canvasPanels[1].canvas.querySelector("h1") as HTMLElement;
    expect(baseH1.style.color).toBe("");
    expect(mdH1.style.color).toBe("orange");
    // Compound path through the media block
    const mdQuoteP = canvasPanels[1].canvas.querySelector("blockquote p") as HTMLElement;
    expect(mdQuoteP.style.color).toBe("navy");
  });
});

// ─── renderComponentPreview (registered npm component) ────────────────────────

describe("renderComponentPreview registered npm components", () => {
  test("instantiates the element and applies prop defaults", async () => {
    if (!customElements.get("x-sb-comp")) {
      customElements.define("x-sb-comp", class extends HTMLElement {});
    }
    const el = await renderComponentPreview({
      props: [
        { default: "'hello'", name: "label" },
        { default: "false", name: "disabled" },
        { default: "''", name: "empty" },
        { name: "nodefault" },
      ],
      source: "npm",
      tagName: "x-sb-comp",
    } as never);
    expect(el.tagName.toLowerCase()).toBe("x-sb-comp");
    expect(el.getAttribute("label")).toBe("hello");
    expect(el.hasAttribute("disabled")).toBe(false);
    expect(el.hasAttribute("empty")).toBe(false);
    expect(el.hasAttribute("nodefault")).toBe(false);
  });
});

// ─── selectStylebookTag + overlays ────────────────────────────────────────────

describe("selectStylebookTag", () => {
  test("updates selection session state without touching media by default", () => {
    const tab = makeTab();
    tab.session.ui.activeMedia = "md";
    renderStylebookMode(ctx);
    selectStylebookTag("h1");
    expect(tab.session.selection).toEqual([]);
    expect(tab.session.ui.activeSelector).toBe("h1");
    expect(tab.session.ui.rightTab).toBe("style");
    expect(tab.session.ui.stylebookSelection).toBe("h1");
    expect(tab.session.ui.activeMedia).toBe("md");
  });

  test("sets activeMedia when a media argument is provided", () => {
    const tab = makeTab();
    tab.session.ui.activeMedia = "md";
    renderStylebookMode(ctx);
    selectStylebookTag("p", null);
    expect(tab.session.ui.activeMedia).toBeNull();
  });

  test("pans the canvas to the selected card when requested", () => {
    makeTab();
    renderStylebookMode(ctx);
    selectStylebookTag("h1", null, { panCanvas: true });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  test("does not pan for unknown tags", () => {
    makeTab();
    renderStylebookMode(ctx);
    selectStylebookTag("not-a-tag", null, { panCanvas: true });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("draws a labelled selection overlay box", () => {
    makeTab();
    renderStylebookMode(ctx);
    selectStylebookTag("h1");
    const [{ overlay }] = canvasPanels;
    const box = overlay.querySelector(".overlay-selection") as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.top).toBe("2px");
    expect(box.querySelector(".overlay-label")?.textContent).toBe("<h1>");
  });
});

describe("renderStylebookOverlays", () => {
  test("no-op when there are no panels", () => {
    makeTab();
    canvasPanels.length = 0;
    expect(() => {
      renderStylebookOverlays();
    }).not.toThrow();
  });

  test("draws an unlabelled hover box distinct from the selection", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    tab.session.ui.stylebookSelection = "h1";
    (canvasPanels[0] as unknown as Record<string, unknown>)._lastHoverTag = "p";
    renderStylebookOverlays();
    const [{ overlay }] = canvasPanels;
    const hover = overlay.querySelector(".overlay-hover") as HTMLElement;
    const selection = overlay.querySelector(".overlay-selection") as HTMLElement;
    expect(hover).not.toBeNull();
    expect(hover.querySelector(".overlay-label")).toBeNull();
    expect(selection.querySelector(".overlay-label")?.textContent).toBe("<h1>");
  });

  test("hovering the selected tag draws only the selection box", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    tab.session.ui.stylebookSelection = "h1";
    (canvasPanels[0] as unknown as Record<string, unknown>)._lastHoverTag = "h1";
    renderStylebookOverlays();
    const [{ overlay }] = canvasPanels;
    expect(overlay.querySelector(".overlay-hover")).toBeNull();
    expect(overlay.querySelector(".overlay-selection")).not.toBeNull();
  });
});

// ─── panel events (click + hover) ─────────────────────────────────────────────

function clickAt(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
}

describe("stylebook panel events", () => {
  test("clicking a card selects its tag and clears media for base panels", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    const [panel] = canvasPanels;
    const h1 = panel.canvas.querySelector("h1") as HTMLElement;
    pointElements = [h1];
    tab.session.ui.activeMedia = "md";
    ctxMocks.updateActivePanelHeaders.mockClear();

    clickAt(panel.overlayClk as HTMLElement);

    expect(tab.session.ui.stylebookSelection).toBe("h1");
    expect(tab.session.ui.activeMedia).toBeNull();
    expect(ctxMocks.updateActivePanelHeaders).toHaveBeenCalled();
  });

  test("clicking a card in a breakpoint panel activates that media", () => {
    const tab = makeTab({ $media: { "--": "320px", md: "(min-width: 768px)" } });
    renderStylebookMode(ctx);
    const [, mdPanel] = canvasPanels;
    const h1 = mdPanel.canvas.querySelector("h1") as HTMLElement;
    pointElements = [h1];

    clickAt(mdPanel.overlayClk as HTMLElement);

    expect(tab.session.ui.stylebookSelection).toBe("h1");
    expect(tab.session.ui.activeMedia).toBe("md");
  });

  test("nested children resolve to compound tags on click", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    const [panel] = canvasPanels;
    const li = panel.canvas.querySelector("ul li") as HTMLElement;
    pointElements = [li];

    clickAt(panel.overlayClk as HTMLElement);

    expect(tab.session.ui.stylebookSelection).toBe("ul li");
  });

  test("clicking empty space clears the stylebook selection", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    selectStylebookTag("h1");
    pointElements = [];

    clickAt(canvasPanels[0].overlayClk as HTMLElement);

    expect(tab.session.ui.stylebookSelection).toBeNull();
    expect(tab.session.ui.activeSelector).toBeNull();
  });

  test("elements outside the panel canvas are ignored", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    selectStylebookTag("h1");
    const outsider = document.createElement("div");
    document.body.append(outsider);
    pointElements = [outsider];

    clickAt(canvasPanels[0].overlayClk as HTMLElement);

    expect(tab.session.ui.stylebookSelection).toBeNull();
  });

  test("clicking an unmapped element inside the canvas clears the selection", () => {
    const tab = makeTab();
    renderStylebookMode(ctx);
    selectStylebookTag("h1");
    const [panel] = canvasPanels;
    // Section labels live inside the canvas but have no tag mapping up to the canvas
    const label = panel.canvas.querySelector(".sb-label") as HTMLElement;
    pointElements = [label];

    clickAt(panel.overlayClk as HTMLElement);

    expect(tab.session.ui.stylebookSelection).toBeNull();
  });

  test("mousemove over an unmapped element keeps hover empty", () => {
    makeTab();
    renderStylebookMode(ctx);
    const [panel] = canvasPanels;
    const label = panel.canvas.querySelector(".sb-label") as HTMLElement;
    pointElements = [label, panel.canvas.querySelector("h1") as HTMLElement];

    (panel.overlayClk as HTMLElement).dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }),
    );

    // First candidate has no mapping; the second resolves, then the loop breaks
    expect((panel as unknown as Record<string, unknown>)._lastHoverTag).toBe("h1");
  });

  test("mousemove tracks the hovered tag and renders a hover overlay", () => {
    makeTab();
    renderStylebookMode(ctx);
    const [panel] = canvasPanels;
    const h1 = panel.canvas.querySelector("h1") as HTMLElement;
    pointElements = [h1];

    (panel.overlayClk as HTMLElement).dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }),
    );

    expect((panel as unknown as Record<string, unknown>)._lastHoverTag).toBe("h1");
    expect(panel.overlay.querySelector(".overlay-hover")).not.toBeNull();

    // Moving off elements clears the hover
    pointElements = [];
    (panel.overlayClk as HTMLElement).dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 6, clientY: 6 }),
    );
    expect((panel as unknown as Record<string, unknown>)._lastHoverTag).toBeNull();
    expect(panel.overlay.querySelector(".overlay-hover")).toBeNull();
  });
});

// ─── refreshStylebookStyles ───────────────────────────────────────────────────

describe("refreshStylebookStyles", () => {
  test("no-op when there is no active tab", () => {
    makeTab();
    renderStylebookMode(ctx);
    closeAllTabs();
    expect(() => {
      refreshStylebookStyles();
    }).not.toThrow();
  });

  test("re-applies simple tag styles to mapped cards and CSS variables in place", () => {
    const tab = makeTab({ style: { "--accent": "red", h1: { color: "red" } } });
    renderStylebookMode(ctx);
    const [{ canvas }] = canvasPanels;
    const h1 = canvas.querySelector("h1") as HTMLElement;
    // The card wrapper is the element registered in the stylebook tag map
    const card = h1.closest(".element-card") as HTMLElement;
    expect(h1.style.color).toBe("red");

    (tab.doc.document as Record<string, unknown>).style = {
      "--accent": "blue",
      h1: { color: "green" },
    };
    refreshStylebookStyles();

    expect(canvas.querySelector("h1")).toBe(h1 as never);
    expect(card.style.color).toBe("green");
    expect(canvas.style.getPropertyValue("--accent")).toBe("blue");
  });

  test("clears stale styles back to the entry base", () => {
    const tab = makeTab({ style: { h1: { color: "red" } } });
    renderStylebookMode(ctx);
    const card = canvasPanels[0].canvas
      .querySelector("h1")!
      .closest(".element-card") as HTMLElement;
    (tab.doc.document as Record<string, unknown>).style = { h1: { margin: "1px" } };
    refreshStylebookStyles();
    expect(card.style.margin).toBe("1px");
    expect(card.style.color).toBe("");
  });

  test("applies compound selector styles to nested elements", () => {
    const tab = makeTab({ style: {} });
    renderStylebookMode(ctx);
    const li = canvasPanels[0].canvas.querySelector("ul li") as HTMLElement;
    (tab.doc.document as Record<string, unknown>).style = {
      ul: { li: { color: "purple" } },
    };
    refreshStylebookStyles();
    expect(li.style.color).toBe("purple");
  });

  test("applies media overrides only in matching panels (selector wraps media)", () => {
    const tab = makeTab({
      $media: { "--": "320px", md: "(min-width: 768px)" },
      style: { h1: { color: "red" } },
    });
    renderStylebookMode(ctx);
    const baseCard = canvasPanels[0].canvas
      .querySelector("h1")!
      .closest(".element-card") as HTMLElement;
    const mdCard = canvasPanels[1].canvas
      .querySelector("h1")!
      .closest(".element-card") as HTMLElement;

    (tab.doc.document as Record<string, unknown>).style = {
      h1: { "@md": { color: "blue" }, color: "red" },
    };
    refreshStylebookStyles();

    expect(baseCard.style.color).toBe("red");
    expect(mdCard.style.color).toBe("blue");
  });

  test("applies top-level @media tag styles (media wraps selector)", () => {
    const tab = makeTab({
      $media: { "--": "320px", md: "(min-width: 768px)" },
      style: {},
    });
    renderStylebookMode(ctx);
    const baseCard = canvasPanels[0].canvas
      .querySelector("h1")!
      .closest(".element-card") as HTMLElement;
    const mdCard = canvasPanels[1].canvas
      .querySelector("h1")!
      .closest(".element-card") as HTMLElement;

    (tab.doc.document as Record<string, unknown>).style = {
      "@md": { h1: { color: "teal" } },
    };
    refreshStylebookStyles();

    expect(baseCard.style.color).toBe("");
    expect(mdCard.style.color).toBe("teal");
  });
});
