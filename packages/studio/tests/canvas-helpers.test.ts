import { resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  bubbleInlinePath,
  findCanvasElement,
  getActivePanel,
  panelMediaToActiveMedia,
  panelOfSurface,
} from "../src/canvas/canvas-helpers";
import { activeCanvasSurface, surfaceForPane } from "../src/canvas/canvas-surface";
import { PRIMARY_PANE, SECONDARY_PANE, closeAllTabs, workspace } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";

/* The panels of the FOCUSED pane's stage. Panels belong to a pane's surface now, not to the
   app (`src/canvas/canvas-surface.ts`); the array identity is stable, so a module-level
   binding still sees what the render mutated. */
const canvasPanels = activeCanvasSurface().panels;

beforeEach(() => {
  resetStudioState();
  canvasPanels.length = 0;
  closeAllTabs();
});

// ─── panelMediaToActiveMedia ──────────────────────────────────────────────────

describe("panelMediaToActiveMedia", () => {
  test("empty string means base context (null)", () => {
    expect(panelMediaToActiveMedia("")).toBeNull();
  });

  test("null and undefined mean base context", () => {
    const missing: string | undefined = undefined;
    expect(panelMediaToActiveMedia(null)).toBeNull();
    expect(panelMediaToActiveMedia(missing)).toBeNull();
  });

  test("'base' maps to null", () => {
    expect(panelMediaToActiveMedia("base")).toBeNull();
  });

  test("named breakpoint passes through", () => {
    expect(panelMediaToActiveMedia("md")).toBe("md");
  });
});

// ─── getActivePanel ───────────────────────────────────────────────────────────

describe("getActivePanel", () => {
  test("returns null when there are no panels", () => {
    expect(getActivePanel()).toBeNull();
  });

  test("returns the only panel when there is exactly one", () => {
    const panel = { mediaName: "anything" };
    canvasPanels.push(panel as never);
    expect(getActivePanel()).toBe(panel as never);
  });

  test("activeMedia null resolves to the base panel", () => {
    resetWorkspaceWithTab();
    const base = { mediaName: "base" };
    const md = { mediaName: "md" };
    canvasPanels.push(md as never, base as never);
    expect(getActivePanel()).toBe(base as never);
  });

  test("activeMedia null resolves to a null-media panel", () => {
    resetWorkspaceWithTab();
    const plain = { mediaName: null };
    const md = { mediaName: "md" };
    canvasPanels.push(md as never, plain as never);
    expect(getActivePanel()).toBe(plain as never);
  });

  test("named activeMedia resolves to the matching panel", () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.activeMedia = "md";
    const base = { mediaName: "base" };
    const md = { mediaName: "md" };
    canvasPanels.push(base as never, md as never);
    expect(getActivePanel()).toBe(md as never);
  });

  test("falls back to the first panel when nothing matches", () => {
    const tab = resetWorkspaceWithTab();
    tab.session.ui.activeMedia = "xl";
    const sm = { mediaName: "sm" };
    const md = { mediaName: "md" };
    canvasPanels.push(sm as never, md as never);
    expect(getActivePanel()).toBe(sm as never);
  });

  test("no active tab behaves like activeMedia null", () => {
    closeAllTabs();
    const base = { mediaName: "base" };
    canvasPanels.push({ mediaName: "md" } as never, base as never);
    expect(getActivePanel()).toBe(base as never);
  });
});

// ─── panelOfSurface, in a lens ────────────────────────────────────────────────

/*
 * "The active panel" is what the block action bar anchors to, what the Style panel resolves its
 * breakpoint context from, and what every panel-relative measurement starts at — so a lens getting
 * it wrong is not one wrong artboard, it is every one of those addressing the pane beside it.
 *
 * The line that decides it is `activeMediaOfPane(surface.paneId)`, and spelling it
 * `tabOfPane(...)?.session.ui.activeMedia` — which is what it means for every OTHER pane, and what
 * it was before the lens existed — left the whole suite green.
 */
describe("panelOfSurface in a breakpoint lens", () => {
  test("resolves the LENS's own breakpoint, not the breakpoint of the tab it shares", () => {
    const tab = resetWorkspaceWithTab();
    // The tab is on the base artboard in the pane that owns it.
    tab.session.ui.activeMedia = null;
    workspace.panes.push({ activeTabId: null, derived: null, id: SECONDARY_PANE, tabOrder: [] });
    workspace.panes[1]!.derived = {
      diff: null,
      kind: "lens",
      media: "md",
      mode: "design",
      preset: "breakpoint",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
    };
    const side = surfaceForPane(SECONDARY_PANE);
    const base = { mediaName: "base" };
    const md = { mediaName: "md" };
    side.panels.length = 0;
    side.panels.push(base as never, md as never);
    canvasPanels.push(base as never, md as never);

    expect(panelOfSurface(side)).toBe(md as never);
    // …and the pane that owns the tab still answers with the tab's, which is the base artboard.
    expect(getActivePanel()).toBe(base as never);
    side.panels.length = 0;
  });
});

// ─── bubbleInlinePath ─────────────────────────────────────────────────────────

describe("bubbleInlinePath", () => {
  const doc: JxMutableNode = {
    children: [
      {
        children: [{ tagName: "strong", textContent: "bold" }],
        tagName: "p",
      },
      {
        children: [{ children: [{ tagName: "em" }], tagName: "p" }],
        tagName: "section",
      },
    ],
    tagName: "div",
  };

  test("returns path unchanged when doc is undefined", () => {
    const path = ["children", 0];
    expect(bubbleInlinePath(undefined, path)).toBe(path);
  });

  test("bubbles inline strong out of its paragraph", () => {
    const result = bubbleInlinePath(doc, ["children", 0, "children", 0]);
    expect(result).toEqual(["children", 0]);
  });

  test("stops at a non-inline ancestor (p inside div)", () => {
    const result = bubbleInlinePath(doc, ["children", 0]);
    expect(result).toEqual(["children", 0]);
  });

  test("non-inline child is returned as-is", () => {
    // P inside section is not inline-in-context
    const result = bubbleInlinePath(doc, ["children", 1, "children", 0]);
    expect(result).toEqual(["children", 1, "children", 0]);
  });

  test("bubbles em out of nested paragraph but not past section", () => {
    const result = bubbleInlinePath(doc, ["children", 1, "children", 0, "children", 0]);
    expect(result).toEqual(["children", 1, "children", 0]);
  });

  test("invalid path (missing node) returns original path", () => {
    const path = ["children", 9, "children", 0];
    expect(bubbleInlinePath(doc, path)).toBe(path);
  });

  test("short path (root) is returned as-is", () => {
    const path: (string | number)[] = [];
    expect(bubbleInlinePath(doc, path)).toBe(path);
  });

  test("defaults missing tagNames to div (non-inline)", () => {
    const anonDoc: JxMutableNode = {
      children: [{ children: [{ textContent: "x" }] }],
    } as JxMutableNode;
    const result = bubbleInlinePath(anonDoc, ["children", 0, "children", 0]);
    expect(result).toEqual(["children", 0, "children", 0]);
  });
});

// ─── findCanvasElement ────────────────────────────────────────────────────────

describe("findCanvasElement", () => {
  function buildCanvas() {
    const canvas = document.createElement("div");
    const root = document.createElement("div");
    const p0 = document.createElement("p");
    p0.textContent = "first";
    const p1 = document.createElement("p");
    p1.textContent = "second";
    root.append(p0, p1);
    canvas.append(root);
    return { canvas, p0, p1, root };
  }

  test("returns null for an empty canvas", () => {
    const canvas = document.createElement("div");
    expect(findCanvasElement([], canvas)).toBeNull();
  });

  test("empty path returns the root element", () => {
    const { canvas, root } = buildCanvas();
    expect(findCanvasElement([], canvas)).toBe(root);
  });

  test("walks children indices in the rendered DOM", () => {
    const { canvas, p1 } = buildCanvas();
    expect(findCanvasElement(["children", 1], canvas)).toBe(p1);
  });

  test("returns null when path key is not children/cases", () => {
    const { canvas } = buildCanvas();
    expect(findCanvasElement(["style", 0], canvas)).toBeNull();
  });

  test("supports cases segments", () => {
    const { canvas, p0 } = buildCanvas();
    expect(findCanvasElement(["cases", 0], canvas)).toBe(p0);
  });

  test("undefined index falls to first child", () => {
    const { canvas, p0 } = buildCanvas();
    expect(findCanvasElement(["children"], canvas)).toBe(p0);
  });

  test("'map' index dives through the repeater perimeter", () => {
    const canvas = document.createElement("div");
    const root = document.createElement("div");
    const wrapper = document.createElement("div");
    const item = document.createElement("li");
    wrapper.append(item);
    root.append(wrapper);
    canvas.append(root);
    expect(findCanvasElement(["children", "map"], canvas)).toBe(item);
  });

  test("resolves an array member node (perimeter) and its template via the 'map' hop", () => {
    const canvas = document.createElement("div");
    const root = document.createElement("div");
    const p0 = document.createElement("p");
    const perimeter = document.createElement("div"); // Array member at children[1]
    const item = document.createElement("li"); // Template
    perimeter.append(item);
    root.append(p0, perimeter);
    canvas.append(root);
    expect(findCanvasElement(["children", 1], canvas)).toBe(perimeter);
    expect(findCanvasElement(["children", 1, "map"], canvas)).toBe(item);
  });

  test("returns null when the walk dead-ends past the rendered children", () => {
    const { canvas } = buildCanvas();
    expect(findCanvasElement(["children", 5], canvas)).toBeNull();
  });
});
