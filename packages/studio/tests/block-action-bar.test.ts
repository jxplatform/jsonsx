/**
 * Tests for src/panels/block-action-bar.ts — the floating action bar above the selected element.
 *
 * Renders against a real tab + in-memory canvas panel (canvasPanels/elToPath from the store), with
 * the pragmatic-drag-and-drop adapter mocked so drag-handle registration is observable. Covers bar
 * structure per selection kind, parent/move/convert actions, inline formatting, and the link
 * popover.
 */
import { flush, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getConvertTargets } from "../src/editor/convert-targets";
import { startEditing, stopEditing } from "../src/editor/inline-edit";
import { dismissSlashMenu, isSlashMenuOpen } from "../src/editor/slash-menu";
import { componentRegistry } from "../src/files/components";
import { canvasPanels, elToPath } from "../src/store";
import { initLayers } from "../src/ui/layers";
import { view } from "../src/view";
import { activeTab } from "../src/workspace/workspace";

import type { JxPath } from "../src/state";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── DnD adapter mock (must precede the module-under-test import) ────────────

const dnd: { draggables: { element: HTMLElement; getInitialData: () => unknown }[] } = {
  draggables: [],
};

mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: (opts: { element: HTMLElement; getInitialData: () => unknown }) => {
    dnd.draggables.push(opts);
    return () => {};
  },
}));

const { dismissBlockActionBar, dismissLinkPopover, initBlockActionBar, renderBlockActionBar } =
  await import("../src/panels/block-action-bar");

// ─── Layer hosts ─────────────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
}
initLayers();

// ─── Fixtures ────────────────────────────────────────────────────────────────

let canvasMode = "design";
let navigated: string[] = [];
let canvas: HTMLElement;
let rootEl: HTMLElement;

/** Build canvas DOM mirroring the doc, registering every element in elToPath. */
function buildCanvas(docNode: JxMutableNode) {
  canvas = document.createElement("div");
  const build = (node: JxMutableNode, path: JxPath): HTMLElement => {
    const el = document.createElement(node.tagName ?? "div");
    elToPath.set(el, path);
    if (typeof node.textContent === "string") {
      el.textContent = node.textContent;
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const [i, child] of kids.entries()) {
      if (typeof child === "object" && child !== null) {
        el.append(build(child as JxMutableNode, [...path, "children", i]));
      }
    }
    return el;
  };
  rootEl = build(docNode, []);
  canvas.append(rootEl);
  document.body.append(canvas);
  canvasPanels.push({
    canvas,
    mediaName: "base",
    viewport: document.createElement("div"),
  } as never);
}

function setup(docNode: JxMutableNode, selection: JxPath | null) {
  const tab = resetWorkspaceWithTab(docNode);
  tab.session.selection = selection as never;
  buildCanvas(tab.doc.document);
  return tab;
}

function bar(): HTMLElement | null {
  return (view.blockActionBarEl?.querySelector(".block-action-bar") as HTMLElement) ?? null;
}

function barButton(title: string): HTMLElement {
  const btn = bar()?.querySelector(`sp-action-button[title^="${title}"]`) as HTMLElement | null;
  if (!btn) {
    throw new Error(`bar button not found: ${title}`);
  }
  return btn;
}

function doc(): JxMutableNode {
  return activeTab.value!.doc.document;
}

function linkPopoverHost(): HTMLElement | null {
  return document.querySelector("#layer-popover sp-popover.link-popover")?.parentElement ?? null;
}

// ─── Pre-init behavior ───────────────────────────────────────────────────────

test("renderBlockActionBar is a no-op before initBlockActionBar", () => {
  renderBlockActionBar();
  expect(view.blockActionBarEl).toBeNull();
});

// ─── Initialized behavior ────────────────────────────────────────────────────

describe("block action bar", () => {
  beforeAll(() => {
    initBlockActionBar({
      getCanvasMode: () => canvasMode,
      navigateToComponent: (path: string) => navigated.push(path),
    });
  });

  beforeEach(() => {
    canvasMode = "design";
    navigated = [];
    dnd.draggables.length = 0;
    componentRegistry.length = 0;
    canvasPanels.length = 0;
  });

  afterEach(() => {
    stopEditing();
    dismissSlashMenu();
    dismissLinkPopover();
    dismissBlockActionBar();
    window.getSelection()?.removeAllRanges();
    view.savedRange = null;
    if (view.selDragCleanup) {
      view.selDragCleanup();
      view.selDragCleanup = null;
    }
    canvas?.remove();
    canvasPanels.length = 0;
  });

  // ─── Dismissal conditions ──────────────────────────────────────────────────

  test("renders nothing outside design/edit modes, without selection, panel, or element", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);

    canvasMode = "preview";
    renderBlockActionBar();
    expect(bar()).toBeNull();

    canvasMode = "design";
    activeTab.value!.session.selection = null as never;
    renderBlockActionBar();
    expect(bar()).toBeNull();

    activeTab.value!.session.selection = ["children", 0] as never;
    canvasPanels.length = 0; // No active panel
    renderBlockActionBar();
    expect(bar()).toBeNull();
  });

  test("renders nothing when the selected element is missing from the canvas", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 5]);
    renderBlockActionBar();
    expect(bar()).toBeNull();
  });

  test("renders nothing when the element exists but the doc node does not", () => {
    setup({ children: [], tagName: "div" }, ["children", 0]);
    const orphan = document.createElement("p");
    elToPath.set(orphan, ["children", 0]);
    rootEl.append(orphan);
    renderBlockActionBar();
    expect(bar()).toBeNull();
  });

  test("dismissBlockActionBar clears the bar", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    expect(bar()).not.toBeNull();
    dismissBlockActionBar();
    expect(bar()).toBeNull();
  });

  // ─── Structure ─────────────────────────────────────────────────────────────

  test("child selection renders badge, parent selector, drag handle, arrows, and convert", () => {
    setup(
      {
        children: [
          { tagName: "p", textContent: "A" },
          { tagName: "p", textContent: "B" },
        ],
        tagName: "div",
      },
      ["children", 0],
    );
    renderBlockActionBar();

    const barEl = bar()!;
    expect(barEl.querySelector(".bar-tag")!.textContent!.trim()).toBe("p");
    expect(barEl.querySelector(".bar-tag")!.classList.contains("bar-tag--interactive")).toBe(true);
    expect(barEl.querySelector("sp-icon-back")).not.toBeNull(); // Parent selector
    expect(barEl.querySelector(".bar-drag-handle")!.textContent).toContain("⠿");
    expect(barButton("Move up").hasAttribute("disabled")).toBe(true); // Idx 0
    expect(barButton("Move down").hasAttribute("disabled")).toBe(false);
    expect(barButton("Convert to Component")).not.toBeNull();
    expect(barEl.querySelector("sp-action-group")).toBeNull(); // Not editing
    expect(barEl.getAttribute("style")).toContain("top:4px"); // Zero rect → bottom + 4
  });

  test("positions above the element when there is headroom", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    stubRect(rootEl.children[0]!, { height: 50, left: 30, top: 200, width: 100 });
    renderBlockActionBar();
    const style = bar()!.getAttribute("style")!;
    expect(style).toContain("left:30px");
    expect(style).toContain("top:162px"); // 200 - 38
  });

  test("root selection renders only the tag badge", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, []);
    renderBlockActionBar();
    const barEl = bar()!;
    expect(barEl.querySelector(".bar-tag")!.textContent!.trim()).toBe("div");
    expect(barEl.querySelector("sp-icon-back")).toBeNull();
    expect(barEl.querySelector(".bar-drag-handle")).toBeNull();
    expect(barEl.querySelector('sp-action-button[title^="Move"]')).toBeNull();
    expect(barEl.querySelector('sp-action-button[title="Convert to Component"]')).toBeNull();
  });

  test("badge prefers the node $id over the tag name", () => {
    setup({ children: [{ $id: "hero", tagName: "section" } as never], tagName: "div" }, [
      "children",
      0,
    ]);
    renderBlockActionBar();
    expect(bar()!.querySelector(".bar-tag")!.textContent!.trim()).toBe("hero");
  });

  test("clamps the bar into the window after layout", async () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    const barEl = bar()!;
    stubRect(barEl, { height: 30, left: window.innerWidth - 100, top: 0, width: 300 });
    await flush();
    expect(barEl.style.left).toBe(`${window.innerWidth - 300}px`);
  });

  // ─── Bar mousedown focus guard ─────────────────────────────────────────────

  test("bar mousedown is prevented except on the drag handle and interactive badge", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    const barEl = bar()!;

    const down = (target: Element) => {
      const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(down(barEl.querySelector("sp-icon-back")!)).toBe(true);
    expect(down(barEl.querySelector(".bar-drag-handle")!)).toBe(false);
    expect(down(barEl.querySelector(".bar-tag--interactive")!)).toBe(false);
  });

  // ─── Parent selection & movement ───────────────────────────────────────────

  test("parent selector click selects the parent path", () => {
    setup({ children: [{ children: [{ tagName: "em" }], tagName: "p" }], tagName: "div" }, [
      "children",
      0,
      "children",
      0,
    ]);
    renderBlockActionBar();
    bar()!.querySelector("sp-icon-back")!.parentElement!.click();
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
  });

  test("Move down and Move up reorder siblings and track the selection", () => {
    setup(
      {
        children: [
          { tagName: "p", textContent: "A" },
          { tagName: "p", textContent: "B" },
        ],
        tagName: "div",
      },
      ["children", 0],
    );
    renderBlockActionBar();

    barButton("Move down").click();
    let children = doc().children as JxMutableNode[];
    expect(children.map((c) => c.textContent)).toEqual(["B", "A"]);
    expect(activeTab.value!.session.selection).toEqual(["children", 1]);

    renderBlockActionBar(); // Selection now at idx 1
    barButton("Move up").click();
    children = doc().children as JxMutableNode[];
    expect(children.map((c) => c.textContent)).toEqual(["A", "B"]);
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
  });

  test("Move up at the first index and Move down at the last index are no-ops", () => {
    setup(
      {
        children: [
          { tagName: "p", textContent: "A" },
          { tagName: "p", textContent: "B" },
        ],
        tagName: "div",
      },
      ["children", 0],
    );
    renderBlockActionBar();
    barButton("Move up").click(); // Disabled guard
    expect((doc().children as JxMutableNode[]).map((c) => c.textContent)).toEqual(["A", "B"]);

    activeTab.value!.session.selection = ["children", 1] as never;
    renderBlockActionBar();
    expect(barButton("Move down").hasAttribute("disabled")).toBe(true);
    barButton("Move down").click();
    expect((doc().children as JxMutableNode[]).map((c) => c.textContent)).toEqual(["A", "B"]);
  });

  // ─── Tag badge conversion ──────────────────────────────────────────────────

  test("badge click opens a slash menu of convert targets; Enter retags the node", async () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();

    const targets = getConvertTargets("p", false);
    (bar()!.querySelector(".bar-tag--interactive") as HTMLElement).click();
    expect(isSlashMenuOpen()).toBe(true);
    expect(document.querySelectorAll("sp-menu-item").length).toBe(targets.length);

    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush();
    expect((doc().children as JxMutableNode[])[0]!.tagName).toBe(targets[0]!.tag);
  });

  test("empty nodes (no children or a lone br) offer the wider when-empty target set", () => {
    const emptyTargets = getConvertTargets("p", true);
    expect(emptyTargets.length).toBeGreaterThan(getConvertTargets("p", false).length);

    setup({ children: [{ children: [], tagName: "p" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    (bar()!.querySelector(".bar-tag--interactive") as HTMLElement).click();
    expect(document.querySelectorAll("sp-menu-item").length).toBe(emptyTargets.length);
    dismissSlashMenu();

    setup({ children: [{ children: [{ tagName: "br" }], tagName: "p" }], tagName: "div" }, [
      "children",
      0,
    ]);
    renderBlockActionBar();
    (bar()!.querySelector(".bar-tag--interactive") as HTMLElement).click();
    expect(document.querySelectorAll("sp-menu-item").length).toBe(emptyTargets.length);
  });

  // ─── Component nodes ───────────────────────────────────────────────────────

  test("registered components get a non-interactive badge and an Edit Component button", () => {
    componentRegistry.push({ path: "components/card.json", tagName: "x-card" } as never);
    setup({ children: [{ tagName: "x-card" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();

    const badge = bar()!.querySelector(".bar-tag")!;
    expect(badge.textContent!.trim()).toBe("x-card");
    expect(badge.classList.contains("bar-tag--interactive")).toBe(false);
    expect(bar()!.querySelector('sp-action-button[title="Convert to Component"]')).toBeNull();

    barButton("Edit Component").click();
    expect(navigated).toEqual(["components/card.json"]);
  });

  // ─── Drag handle ───────────────────────────────────────────────────────────

  test("drag handle registers a draggable carrying the selection path", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();

    expect(view.selDragCleanup).toBeInstanceOf(Function);
    expect(dnd.draggables.length).toBe(1);
    expect(dnd.draggables[0]!.element.classList.contains("bar-drag-handle")).toBe(true);
    expect(dnd.draggables[0]!.getInitialData()).toEqual({
      path: ["children", 0],
      type: "tree-node",
    });
  });

  test("re-rendering replaces the previous drag registration", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    let cleaned = false;
    view.selDragCleanup = () => (cleaned = true);
    renderBlockActionBar();
    expect(cleaned).toBe(true);
    expect(view.selDragCleanup).toBeInstanceOf(Function);
  });

  // ─── Inline formatting ─────────────────────────────────────────────────────

  function setupEditing() {
    setup({ children: [{ tagName: "p", textContent: "hello" }], tagName: "div" }, ["children", 0]);
    const el = rootEl.children[0] as HTMLElement;
    startEditing(el, ["children", 0], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    renderBlockActionBar();
    return el;
  }

  function selectText(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return range;
  }

  test("format buttons appear while editing, with shortcuts in their titles", () => {
    const el = setupEditing();
    expect(el.getAttribute("contenteditable")).toBe("true");
    const group = bar()!.querySelector("sp-action-group")!;
    const titles = [...group.querySelectorAll("sp-action-button")].map((b) =>
      b.getAttribute("title"),
    );
    expect(titles).toContain("Bold (Cmd+B)");
    expect(titles).toContain("Underline");
    expect(titles.length).toBe(8); // P inline actions
  });

  test("format buttons appear for a contenteditable element even without startEditing", () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    (rootEl.children[0] as HTMLElement).contentEditable = "true";
    renderBlockActionBar();
    expect(bar()!.querySelector("sp-action-group")).not.toBeNull();
  });

  test("active inline tags are reflected in the action group selection", () => {
    setup(
      {
        children: [{ children: [{ tagName: "strong", textContent: "hi" }], tagName: "p" }],
        tagName: "div",
      },
      ["children", 0],
    );
    const el = rootEl.children[0] as HTMLElement;
    el.contentEditable = "true";
    selectText(el.querySelector("strong")!.firstChild!);
    renderBlockActionBar();
    const selected = bar()!.querySelector("sp-action-group")!.getAttribute("selected");
    expect(JSON.parse(selected!)).toEqual(["strong"]);
  });

  test("mousedown + click on Bold wraps the saved selection in <strong>", async () => {
    const el = setupEditing();
    selectText(el.firstChild!);

    const bold = barButton("Bold");
    bold.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); // Captures range
    expect(view.savedRange).not.toBeNull();
    bold.click();
    await flush();

    expect(el.querySelector("strong")).not.toBeNull();
    expect(el.querySelector("strong")!.textContent).toBe("hello");
  });

  test("format click without a saved range or outside contenteditable is a no-op", async () => {
    const el = setupEditing();

    view.savedRange = null;
    barButton("Bold").click();
    await flush();
    expect(el.querySelector("strong")).toBeNull();

    // Saved range outside any contenteditable root
    const stray = document.createElement("span");
    stray.textContent = "outside";
    document.body.append(stray);
    const range = document.createRange();
    range.selectNodeContents(stray.firstChild!);
    view.savedRange = range;
    barButton("Bold").click();
    await flush();
    expect(el.querySelector("strong")).toBeNull();
    stray.remove();
  });

  // ─── Link popover ──────────────────────────────────────────────────────────

  test("Link button opens the popover; Apply creates a link via execCommand", async () => {
    const el = setupEditing();
    selectText(el.firstChild!);
    const execCalls: unknown[][] = [];
    (document as unknown as Record<string, unknown>).execCommand = (...args: unknown[]) => {
      execCalls.push(args);
      return true;
    };

    barButton("Link").click();
    const host = linkPopoverHost()!;
    expect(host.querySelector("sp-popover.link-popover")).not.toBeNull();
    const field = host.querySelector("sp-textfield") as HTMLInputElement;
    expect(field.getAttribute("value")).toBe("");
    const buttons = [...host.querySelectorAll("sp-action-button")];
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(["Apply"]);

    field.value = "https://example.com";
    (buttons[0] as HTMLElement).click();
    await flush();
    expect(execCalls).toEqual([["createLink", false, "https://example.com"]]);
    expect(linkPopoverHost()).toBeNull();
    delete (document as unknown as Record<string, unknown>).execCommand;
  });

  test("inside an existing link the popover offers Update and Remove", async () => {
    setup(
      {
        children: [
          {
            children: [{ attributes: { href: "https://old" }, tagName: "a", textContent: "go" }],
            tagName: "p",
          },
        ],
        tagName: "div",
      },
      ["children", 0],
    );
    const el = rootEl.children[0] as HTMLElement;
    el.contentEditable = "true";
    const anchor = el.querySelector("a")!;
    anchor.setAttribute("href", "https://old");
    renderBlockActionBar();
    selectText(anchor.firstChild!);

    barButton("Link").click();
    let host = linkPopoverHost()!;
    const field = host.querySelector("sp-textfield") as HTMLInputElement;
    expect(field.getAttribute("value")).toBe("https://old");
    const labels = [...host.querySelectorAll("sp-action-button")].map((b) => b.textContent!.trim());
    expect(labels).toEqual(["Update", "Remove"]);

    // Update rewrites the href without execCommand
    field.value = "https://new";
    (host.querySelectorAll("sp-action-button")[0] as HTMLElement).click();
    await flush();
    expect(anchor.getAttribute("href")).toBe("https://new");
    expect(linkPopoverHost()).toBeNull();

    // Reopen and Remove unwraps the link
    selectText(anchor.firstChild!);
    barButton("Link").click();
    host = linkPopoverHost()!;
    (host.querySelectorAll("sp-action-button")[1] as HTMLElement).click();
    await flush();
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("go");
  });

  test("Enter applies and Escape dismisses from the URL field", async () => {
    const el = setupEditing();
    selectText(el.firstChild!);
    const execCalls: unknown[][] = [];
    (document as unknown as Record<string, unknown>).execCommand = (...args: unknown[]) => {
      execCalls.push(args);
      return true;
    };

    barButton("Link").click();
    let field = linkPopoverHost()!.querySelector("sp-textfield") as HTMLInputElement;
    field.value = "https://kbd.example";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush();
    expect(execCalls.length).toBe(1);
    expect(linkPopoverHost()).toBeNull();

    selectText(el.firstChild!);
    barButton("Link").click();
    field = linkPopoverHost()!.querySelector("sp-textfield") as HTMLInputElement;
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await flush();
    expect(linkPopoverHost()).toBeNull();
    expect(execCalls.length).toBe(1); // Escape did not apply
    delete (document as unknown as Record<string, unknown>).execCommand;
  });

  test("dismissLinkPopover clears the popover slot", () => {
    const el = setupEditing();
    selectText(el.firstChild!);
    barButton("Link").click();
    expect(linkPopoverHost()).not.toBeNull();
    dismissLinkPopover();
    expect(linkPopoverHost()).toBeNull();
  });
});
