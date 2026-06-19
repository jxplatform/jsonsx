/**
 * Tests for src/editor/component-inline-edit.ts — plaintext-only inline editing in design mode.
 *
 * Builds fake canvas panels (canvas/overlay/overlayClk) and a real workspace tab, then drives
 * enter/edit/commit flows through DOM events: Escape cancel, Enter split, slash-menu insertion, and
 * the capturing outside-mousedown commit handler.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  enterComponentInlineEdit,
  initComponentInlineEdit,
} from "../src/editor/component-inline-edit";
import { dismissSlashMenu, isSlashMenuOpen } from "../src/editor/slash-menu";
import { canvasPanels, elToPath } from "../src/store";
import { view } from "../src/view";
import type { CanvasPanel } from "../src/panels/canvas-dnd.js";
import type { Tab } from "../src/tabs/tab";

// ─── Environment ──────────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

initComponentInlineEdit({ findCanvasElement: () => null });

let hits: Element[] = [];
(
  document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }
).elementsFromPoint = () => hits;

let panel: CanvasPanel;
let el: HTMLElement;
let tab: Tab;

function makePanel(mediaName = "base") {
  const canvas = document.createElement("div");
  const overlay = document.createElement("div");
  const box = document.createElement("div");
  box.className = "overlay-box";
  overlay.append(box);
  const overlayClk = document.createElement("div");
  document.body.append(canvas, overlay, overlayClk);
  return { canvas, mediaName, overlay, overlayClk } as unknown as CanvasPanel;
}

function freshDoc() {
  return {
    children: [
      { tagName: "p", textContent: "Hello" },
      { tagName: "p", textContent: "World" },
      { tagName: "p", textContent: "" },
    ],
    tagName: "div",
  };
}

function docChildren() {
  return tab.doc.document.children as Record<string, unknown>[];
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetStudioState();
  tab = resetWorkspaceWithTab(freshDoc());
  canvasPanels.length = 0;
  panel = makePanel();
  canvasPanels.push(panel);
  el = document.createElement("p");
  el.textContent = "Hello";
  (panel.canvas as HTMLElement).append(el);
  hits = [];
});

afterEach(() => {
  // Cancel any active edit so document-level handlers don't leak between tests
  if (view.componentInlineEdit) {
    view.componentInlineEdit.el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
  }
  dismissSlashMenu();
  view.blockActionBarEl = null;
  canvasPanels.length = 0;
});

function pressEl(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }),
  );
}

function mousedown(target: EventTarget, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init }));
}

// ─── Entering ─────────────────────────────────────────────────────────────────

describe("enterComponentInlineEdit", () => {
  test("makes the element plaintext-editable and records state", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    expect(view.componentInlineEdit).not.toBeNull();
    expect(view.componentInlineEdit!.el).toBe(el);
    expect(view.componentInlineEdit!.originalText).toBe("Hello");
    expect(view.componentInlineEdit!.mediaName).toBe("base");
    expect(el.getAttribute("contenteditable")).toBe("plaintext-only");
    expect(el.style.cursor).toBe("text");
    // Overlays are disarmed
    expect((panel.overlayClk as HTMLElement).style.pointerEvents).toBe("none");
    const box = (panel.overlay as HTMLElement).querySelector(".overlay-box") as HTMLElement;
    expect(box.style.border).toContain("none");
  });

  test("re-entering on the same element is a no-op", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    const state = view.componentInlineEdit;
    enterComponentInlineEdit(el, ["children", 0]);
    expect(view.componentInlineEdit).toBe(state);
  });

  test("refuses when the node is missing", () => {
    enterComponentInlineEdit(el, ["children", 9]);
    expect(view.componentInlineEdit).toBeNull();
  });

  test("refuses custom components with $props", () => {
    docChildren()[0] = { $props: { x: 1 }, tagName: "my-card" };
    enterComponentInlineEdit(el, ["children", 0]);
    expect(view.componentInlineEdit).toBeNull();
  });

  test("refuses nodes with element children", () => {
    docChildren()[0] = { children: [{ tagName: "span" }], tagName: "div" };
    enterComponentInlineEdit(el, ["children", 0]);
    expect(view.componentInlineEdit).toBeNull();
  });

  test("refuses nodes with dynamic (object) children", () => {
    docChildren()[0] = {
      children: { $prototype: "Array", items: [] } as unknown as [],
      tagName: "div",
    };
    enterComponentInlineEdit(el, ["children", 0]);
    expect(view.componentInlineEdit).toBeNull();
  });

  test("refuses nodes with bound (object) textContent", () => {
    docChildren()[0] = { tagName: "p", textContent: { $ref: "#/state/x" } as unknown as string };
    enterComponentInlineEdit(el, ["children", 0]);
    expect(view.componentInlineEdit).toBeNull();
  });

  test("refuses void elements", () => {
    docChildren()[0] = { tagName: "img" };
    enterComponentInlineEdit(el, ["children", 0]);
    expect(view.componentInlineEdit).toBeNull();
  });

  test("node without textContent starts from empty string", () => {
    docChildren()[0] = { tagName: "p" };
    enterComponentInlineEdit(el, ["children", 0]);
    expect(view.componentInlineEdit!.originalText).toBe("");
    expect(el.textContent).toBe("");
  });
});

// ─── Escape / Enter ───────────────────────────────────────────────────────────

describe("keydown handling", () => {
  test("Escape cancels without committing", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    el.textContent = "Changed";
    pressEl(el, "Escape");
    expect(view.componentInlineEdit).toBeNull();
    expect(el.hasAttribute("contenteditable")).toBe(false);
    expect(docChildren()[0]!.textContent).toBe("Hello");
    expect(tab.doc.dirty).toBe(false);
    expect((panel.overlayClk as HTMLElement).style.pointerEvents).toBe("");
  });

  test("Enter splits the paragraph at the caret", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(el.firstChild!, 3);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    pressEl(el, "Enter");

    expect(docChildren()[0]!.textContent).toBe("Hel");
    expect(docChildren()[1]).toEqual({ tagName: "p", textContent: "lo" });
    expect(docChildren().length).toBe(4);
    expect(tab.session.selection).toEqual(["children", 1]);
    expect(tab.session.ui.pendingInlineEdit).toEqual({
      mediaName: "base",
      path: ["children", 1],
    });
    expect(view.componentInlineEdit).toBeNull();
  });

  test("Enter at the end produces an empty trailing paragraph", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    // Selection is already collapsed at the end after entering
    pressEl(el, "Enter");
    expect(docChildren()[0]!.textContent).toBe("Hello");
    // TextAfter "" → textContent undefined is dropped by mutateUpdateProperty
    expect(docChildren()[1]!.tagName).toBe("p");
    expect(docChildren()[1]!.textContent).toBe("");
  });

  test("Shift+Enter does not split", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    pressEl(el, "Enter", { shiftKey: true });
    expect(docChildren().length).toBe(3);
    expect(view.componentInlineEdit).not.toBeNull();
  });

  test("keydown does not bubble to document handlers", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    let leaked = false;
    const handler = () => {
      leaked = true;
    };
    document.addEventListener("keydown", handler);
    pressEl(el, "x");
    document.removeEventListener("keydown", handler);
    expect(leaked).toBe(false);
  });
});

// ─── Slash menu (component mode) ──────────────────────────────────────────────

describe("component slash commands", () => {
  let emptyEl: HTMLElement;

  beforeEach(() => {
    emptyEl = document.createElement("p");
    (panel.canvas as HTMLElement).append(emptyEl);
  });

  test("typing / in an empty block opens the slash menu", () => {
    enterComponentInlineEdit(emptyEl, ["children", 2]);
    emptyEl.textContent = "/h";
    emptyEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(isSlashMenuOpen()).toBe(true);
  });

  test("non-slash input dismisses the menu", () => {
    enterComponentInlineEdit(emptyEl, ["children", 2]);
    emptyEl.textContent = "/";
    emptyEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(isSlashMenuOpen()).toBe(true);
    emptyEl.textContent = "plain";
    emptyEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("slash input on a non-empty block does not open the menu", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    el.textContent = "/x";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("selecting a text command replaces the block and queues inline edit", () => {
    enterComponentInlineEdit(emptyEl, ["children", 2]);
    emptyEl.textContent = "/head";
    emptyEl.dispatchEvent(new Event("input", { bubbles: true }));
    // First filtered item is Heading 1
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    expect(docChildren()[2]).toEqual({ tagName: "h1", textContent: "Heading" });
    expect(tab.session.selection).toEqual(["children", 2]);
    expect(tab.session.ui.pendingInlineEdit).toEqual({
      mediaName: "base",
      path: ["children", 2],
    });
    expect(view.componentInlineEdit).toBeNull();
  });

  test("selecting a non-text command does not queue inline edit", () => {
    enterComponentInlineEdit(emptyEl, ["children", 2]);
    emptyEl.textContent = "/hr";
    emptyEl.dispatchEvent(new Event("input", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    expect(docChildren()[2]!.tagName).toBe("hr");
    expect(tab.session.ui.pendingInlineEdit).toBeNull();
  });
});

// ─── Outside-click commit ─────────────────────────────────────────────────────

describe("outside mousedown commit", () => {
  test("mousedown inside the editing element does not commit", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    mousedown(el);
    expect(view.componentInlineEdit).not.toBeNull();
  });

  test("mousedown on the block action bar does not commit", () => {
    const bar = document.createElement("div");
    const btn = document.createElement("button");
    bar.append(btn);
    document.body.append(bar);
    view.blockActionBarEl = bar;
    enterComponentInlineEdit(el, ["children", 0]);
    mousedown(btn);
    expect(view.componentInlineEdit).not.toBeNull();
  });

  test("commit with changed text updates the document", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    el.textContent = "Edited";
    mousedown(document.body, { clientX: 5, clientY: 5 });
    expect(view.componentInlineEdit).toBeNull();
    expect(docChildren()[0]!.textContent).toBe("Edited");
    expect(tab.doc.dirty).toBe(true);
  });

  test("commit with unchanged text leaves the document clean", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    mousedown(document.body);
    expect(view.componentInlineEdit).toBeNull();
    expect(docChildren()[0]!.textContent).toBe("Hello");
    expect(tab.doc.dirty).toBe(false);
  });

  test("commit with empty text removes the node", () => {
    enterComponentInlineEdit(el, ["children", 0]);
    el.textContent = "   ";
    mousedown(document.body);
    expect(docChildren().length).toBe(2);
    expect(docChildren()[0]!.textContent).toBe("World");
  });

  test("clicking another canvas element selects it", () => {
    const target = document.createElement("p");
    (panel.canvas as HTMLElement).append(target);
    elToPath.set(target, ["children", 1]);
    hits = [target];

    enterComponentInlineEdit(el, ["children", 0]);
    mousedown(document.body, { clientX: 50, clientY: 50 });

    expect(tab.session.selection).toEqual(["children", 1]);
    expect(tab.session.ui.pendingInlineEdit).toEqual({
      mediaName: "base",
      path: ["children", 1],
    });
    expect(tab.session.ui.activeMedia).toBeNull();
    expect(docChildren()[0]!.textContent).toBe("Hello");
  });

  test("clicking another element with changed text commits then selects", () => {
    const target = document.createElement("p");
    (panel.canvas as HTMLElement).append(target);
    elToPath.set(target, ["children", 1]);
    hits = [target];

    enterComponentInlineEdit(el, ["children", 0]);
    el.textContent = "Rewritten";
    mousedown(document.body);

    expect(docChildren()[0]!.textContent).toBe("Rewritten");
    expect(tab.session.selection).toEqual(["children", 1]);
  });

  test("clicking a later sibling while emptying the block adjusts the hit index", () => {
    const target = document.createElement("p");
    (panel.canvas as HTMLElement).append(target);
    elToPath.set(target, ["children", 1]);
    hits = [target];

    enterComponentInlineEdit(el, ["children", 0]);
    el.textContent = "";
    mousedown(document.body);

    // Children[0] was removed, so the hit at index 1 becomes index 0
    expect(docChildren().length).toBe(2);
    expect(tab.session.selection).toEqual(["children", 0]);
    expect(tab.session.ui.pendingInlineEdit).toEqual({
      mediaName: "base",
      path: ["children", 0],
    });
  });

  test("outside click while the slash menu is open does not commit", async () => {
    const emptyEl = document.createElement("p");
    (panel.canvas as HTMLElement).append(emptyEl);
    enterComponentInlineEdit(emptyEl, ["children", 2]);
    emptyEl.textContent = "/";
    emptyEl.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(isSlashMenuOpen()).toBe(true);
    mousedown(document.body);
    expect(view.componentInlineEdit).not.toBeNull();
  });
});
