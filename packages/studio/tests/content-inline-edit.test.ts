/**
 * Tests for src/editor/content-inline-edit.ts — rich-text inline editing for edit/content mode.
 *
 * Exercises the onCommit/onSplit/onInsert/onEnd callbacks wired into startEditing by driving the
 * real inline-edit lifecycle: stopEditing commits, Enter splits, and slash-menu selection inserts
 * or swaps elements.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { enterInlineEdit } from "../src/editor/content-inline-edit";
import { isEditing, stopEditing } from "../src/editor/inline-edit";
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

let panel: CanvasPanel;
let el: HTMLElement;
let tab: Tab;

function freshDoc() {
  return {
    children: [
      { tagName: "p", textContent: "Hello" },
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
  const canvas = document.createElement("div");
  const overlay = document.createElement("div");
  const overlayClk = document.createElement("div");
  document.body.append(canvas, overlay, overlayClk);
  panel = { canvas, mediaName: "base", overlay, overlayClk } as unknown as CanvasPanel;
  canvasPanels.push(panel);
  el = document.createElement("p");
  el.textContent = "Hello";
  canvas.append(el);
});

afterEach(async () => {
  if (isEditing()) {
    stopEditing();
  }
  dismissSlashMenu();
  await flush();
  canvasPanels.length = 0;
});

function caretAt(node: Node, offset: number) {
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ─── Entering ─────────────────────────────────────────────────────────────────

describe("enterInlineEdit", () => {
  test("enables contenteditable, hides overlays, and registers cleanup", () => {
    enterInlineEdit(el, ["children", 0]);
    expect(isEditing()).toBe(true);
    expect(el.contentEditable).toBe("true");
    expect((panel.overlay as HTMLElement).style.display).toBe("none");
    expect((panel.overlayClk as HTMLElement).style.pointerEvents).toBe("none");
    expect(view.inlineEditCleanup).toBeInstanceOf(Function);
  });

  test("restores escaped template expressions before editing", () => {
    el.textContent = "Hello ❪ name ❫";
    enterInlineEdit(el, ["children", 0]);
    expect(el.textContent).toBe("Hello ${name}");
  });

  test("stopping restores overlays and clears the cleanup hook", () => {
    enterInlineEdit(el, ["children", 0]);
    stopEditing();
    expect((panel.overlay as HTMLElement).style.display).toBe("");
    expect((panel.overlayClk as HTMLElement).style.pointerEvents).toBe("");
    expect(view.inlineEditCleanup).toBeNull();
  });
});

// ─── OnCommit ─────────────────────────────────────────────────────────────────

describe("onCommit", () => {
  test("commits plain text changes as textContent", () => {
    enterInlineEdit(el, ["children", 0]);
    el.textContent = "Edited text";
    stopEditing();
    expect(docChildren()[0]!.textContent).toBe("Edited text");
    expect(docChildren()[0]!.children).toBeUndefined();
    expect(tab.doc.dirty).toBe(true);
  });

  test("unchanged text does not touch the document", () => {
    enterInlineEdit(el, ["children", 0]);
    stopEditing();
    expect(docChildren()[0]!.textContent).toBe("Hello");
    expect(tab.doc.dirty).toBe(false);
  });

  test("commits rich content as a children array and clears textContent", () => {
    enterInlineEdit(el, ["children", 0]);
    el.innerHTML = "Hello <strong>bold</strong>";
    stopEditing();
    const [node] = docChildren();
    expect(node!.textContent).toBeUndefined();
    expect(node!.children).toEqual(["Hello ", { tagName: "strong", textContent: "bold" }]);
  });

  test("identical children commit is a no-op", () => {
    docChildren()[0] = {
      children: ["Hello ", { tagName: "strong", textContent: "bold" }],
      tagName: "p",
    };
    el.innerHTML = "Hello <strong>bold</strong>";
    enterInlineEdit(el, ["children", 0]);
    stopEditing();
    expect(tab.doc.dirty).toBe(false);
  });
});

// ─── OnSplit ──────────────────────────────────────────────────────────────────

describe("onSplit (Enter)", () => {
  test("splits plain text at the caret into two paragraphs", async () => {
    enterInlineEdit(el, ["children", 0]);
    caretAt(el.firstChild!, 3);
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    await flush();

    expect(docChildren()[0]!.textContent).toBe("Hel");
    expect(docChildren()[1]).toEqual({ tagName: "p", textContent: "lo" });
    expect(docChildren().length).toBe(3);
    expect(tab.session.selection).toEqual(["children", 1]);
    expect(isEditing()).toBe(false);
  });

  test("splits rich content into before-children and after-text", async () => {
    el.innerHTML = "ab<em>cd</em>ef";
    enterInlineEdit(el, ["children", 0]);
    caretAt(el.lastChild!, 1); // Between "e" and "f"
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    await flush();

    const [before] = docChildren();
    expect(before!.textContent).toBeUndefined();
    expect(before!.children).toEqual(["ab", { tagName: "em", textContent: "cd" }, "e"]);
    expect(docChildren()[1]).toEqual({ tagName: "p", textContent: "f" });
  });

  test("splits rich content into before-text and after-children", async () => {
    el.innerHTML = "ab<em>cd</em>ef";
    enterInlineEdit(el, ["children", 0]);
    caretAt(el.firstChild!, 1); // Between "a" and "b" — everything after is rich
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    await flush();

    const [before] = docChildren();
    expect(before!.textContent).toBe("a");
    const after = docChildren()[1]!;
    expect(after.textContent).toBeUndefined();
    expect(after.children).toEqual(["b", { tagName: "em", textContent: "cd" }, "ef"]);
  });

  test("split at the very end yields an empty new paragraph", async () => {
    enterInlineEdit(el, ["children", 0]); // Caret placed at end on enter
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    await flush();

    expect(docChildren()[0]!.textContent).toBe("Hello");
    expect(docChildren()[1]).toEqual({ tagName: "p", textContent: "" });
  });
});

// ─── OnInsert (slash menu) ────────────────────────────────────────────────────

async function openSlashMenuOn(target: HTMLElement) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "/" }));
  await flush();
  expect(isSlashMenuOpen()).toBe(true);
}

function pressMenu(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
}

describe("onInsert (slash menu)", () => {
  let emptyEl: HTMLElement;

  beforeEach(() => {
    emptyEl = document.createElement("p");
    (panel.canvas as HTMLElement).append(emptyEl);
  });

  test("empty block swaps its tag for the selected command", async () => {
    enterInlineEdit(emptyEl, ["children", 1]);
    await openSlashMenuOn(emptyEl);
    pressMenu("Enter"); // Heading 1
    await flush();

    expect(docChildren()[1]).toEqual({ tagName: "h1", textContent: "Heading" });
    expect(tab.session.selection).toEqual(["children", 1]);
    expect(docChildren().length).toBe(2);
  });

  test("swap to paragraph drops the boilerplate default text", async () => {
    enterInlineEdit(emptyEl, ["children", 1]);
    await openSlashMenuOn(emptyEl);
    pressMenu("ArrowDown");
    pressMenu("ArrowDown");
    pressMenu("ArrowDown"); // H1 → h2 → h3 → p
    pressMenu("Enter");
    await flush();

    expect(docChildren()[1]!.tagName).toBe("p");
    expect(docChildren()[1]!.textContent).toBeUndefined();
  });

  test("a lone <br> counts as empty and swaps in place", async () => {
    emptyEl.innerHTML = "<br>";
    enterInlineEdit(emptyEl, ["children", 1]);
    await openSlashMenuOn(emptyEl);
    pressMenu("Enter");
    await flush();

    expect(docChildren()[1]!.tagName).toBe("h1");
    expect(docChildren().length).toBe(2);
  });

  test("non-empty block commits its text and inserts the new element after", async () => {
    enterInlineEdit(el, ["children", 0]);
    el.textContent = "hello ";
    caretAt(el.firstChild!, 6); // After trailing space — slash trigger allowed
    await openSlashMenuOn(el);
    pressMenu("Enter"); // Heading 1
    await flush();

    expect(docChildren()[0]!.textContent).toBe("hello ");
    expect(docChildren()[1]).toEqual({ tagName: "h1", textContent: "Heading" });
    expect(docChildren().length).toBe(3);
    expect(tab.session.selection).toEqual(["children", 1]);
    expect(isEditing()).toBe(false);
  });

  test("non-empty rich block commits its children before inserting", async () => {
    el.innerHTML = "hi <em>x</em> ";
    enterInlineEdit(el, ["children", 0]);
    const last = el.lastChild!;
    caretAt(last, (last.textContent ?? "").length); // After the trailing space
    await openSlashMenuOn(el);
    pressMenu("Enter"); // Heading 1
    await flush();

    // The edited block was committed as a rich children array (not textContent).
    expect(docChildren()[0]!.children).toBeDefined();
    expect(docChildren()[0]!.textContent).toBeUndefined();
    expect(docChildren()[1]).toEqual({ tagName: "h1", textContent: "Heading" });
  });

  test("slash menu does not open mid-word", async () => {
    enterInlineEdit(el, ["children", 0]);
    caretAt(el.firstChild!, 3);
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "/" }));
    await flush();
    expect(isSlashMenuOpen()).toBe(false);
  });
});

// ─── RAF re-entry into editing ──────────────────────────────────────────────
// When the new/next element exists in the canvas, the post-mutation rAF re-enters
// Inline editing on it. We map a real editable element to the target path so
// FindCanvasElement resolves it.

describe("re-enters editing on the resulting element", () => {
  let target: HTMLElement;

  beforeEach(() => {
    target = document.createElement("p");
    (panel.canvas as HTMLElement).append(target);
    elToPath.set(el, ["children", 0]);
    elToPath.set(target, ["children", 1]);
  });

  test("onSplit re-enters editing on the new paragraph", async () => {
    enterInlineEdit(el, ["children", 0]);
    caretAt(el.firstChild!, 3);
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    await flush();
    expect(isEditing()).toBe(true);
  });

  test("onInsert into an empty block re-enters editing after the tag swap", async () => {
    const empty = document.createElement("p");
    (panel.canvas as HTMLElement).append(empty);
    elToPath.set(empty, ["children", 1]);
    // Re-point the target so the swapped element at children/1 is found.
    enterInlineEdit(empty, ["children", 1]);
    await openSlashMenuOn(empty);
    pressMenu("Enter");
    await flush();
    expect(isEditing()).toBe(true);
  });

  test("onInsert after a non-empty block re-enters editing on the inserted element", async () => {
    enterInlineEdit(el, ["children", 0]);
    el.textContent = "hello ";
    caretAt(el.firstChild!, 6);
    await openSlashMenuOn(el);
    pressMenu("Enter");
    await flush();
    expect(isEditing()).toBe(true);
  });
});
