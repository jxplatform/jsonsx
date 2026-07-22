/**
 * Coverage-gap tests for the editor helpers:
 *
 * - Inline-edit-apply: unchanged rich-children commits, split with rich/empty after-content, split
 *   with rich before-content, slash-swap onto tags without seed text, slash-insert with rich
 *   pending content.
 * - Convert-to-repeater: Enter-key confirm in the new-definition field, and the guard for documents
 *   whose selection parent has no children array.
 * - Context-menu: text/html clipboard content that converts to nothing (text/plain fallback) and
 *   pasting onto a dangling selection.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SlashCommand } from "../src/editor/inline-edit";
import type { Tab } from "../src/tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";

void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (url: string) => ({ toString: () => url }) },
  editor: { setModelMarkers: mock(() => {}) },
  languages: { registerCompletionItemProvider: mock(() => {}) },
}));
void mock.module("../src/panels/statusbar.js", () => ({ statusMessage: () => {} }));

const { applyInlineCommit, applyInlineInsert, applyInlineSplit } =
  await import("../src/editor/inline-edit-apply");
const { convertToRepeater } = await import("../src/editor/convert-to-repeater");
const { dismissContextMenu, pasteNode, showContextMenu } =
  await import("../src/editor/context-menu");
const { initLayers } = await import("../src/ui/layers");
const { activeTab, workspace } = await import("../src/workspace/workspace");

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

// ─── Inline-edit apply ───────────────────────────────────────────────────────

describe("inline-edit apply gaps", () => {
  let tab: Tab;
  const RICH = ["a ", { tagName: "strong", textContent: "b" }];
  const kids = () => tab.doc.document.children as Record<string, unknown>[];

  beforeEach(() => {
    resetStudioState();
    tab = resetWorkspaceWithTab({
      children: [{ children: structuredClone(RICH), tagName: "p" }],
      tagName: "div",
    } as never);
  });

  test("committing identical rich children is a no-op", () => {
    applyInlineCommit(tab, ["children", 0], structuredClone(RICH) as never, null);
    expect(tab.doc.dirty).toBe(false);
    expect(kids()[0]!.children).toEqual(RICH);
  });

  test("split keeps rich before-content and carries rich after-content into the new <p>", () => {
    const newPath = applyInlineSplit(
      tab,
      ["children", 0],
      { children: ["Hel"] },
      { children: ["lo ", { tagName: "em", textContent: "x" }] },
    );
    expect(newPath).toEqual(["children", 1]);
    expect(kids()[0]!.children).toEqual(["Hel"]);
    expect(kids()[0]!.textContent).toBeUndefined();
    expect(kids()[1]).toEqual({
      children: ["lo ", { tagName: "em", textContent: "x" }],
      tagName: "p",
    });
  });

  test("split with empty after-content seeds a blank paragraph", () => {
    applyInlineSplit(tab, ["children", 0], { textContent: "Left" }, {});
    expect(kids()[0]!.textContent).toBe("Left");
    expect(kids()[1]).toEqual({ tagName: "p", textContent: "" });
  });

  test("slash-swap onto a tag without seed text clears textContent", () => {
    tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "" }],
      tagName: "div",
    } as never);
    const cmd = { tag: "p" } as unknown as SlashCommand;
    const path = applyInlineInsert(tab, ["children", 0], cmd, { textContent: "" });
    expect(path).toEqual(["children", 0]);
    expect(kids()[0]!.tagName).toBe("p");
    expect(kids()[0]!.textContent).toBeUndefined();
  });

  test("slash-insert commits rich pending children before inserting the new element", () => {
    const cmd = { tag: "h2" } as unknown as SlashCommand;
    const pending = { children: ["kept ", { tagName: "strong", textContent: "rich" }] };
    const path = applyInlineInsert(tab, ["children", 0], cmd, pending as never);
    expect(path).toEqual(["children", 1]);
    expect(kids()[0]!.children).toEqual(pending.children);
    expect(kids()[1]!.tagName).toBe("h2");
  });
});

// ─── Convert to repeater ─────────────────────────────────────────────────────

describe("convert-to-repeater gaps", () => {
  function setupLayers() {
    document.body.innerHTML = "";
    for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
      const layer = document.createElement("div");
      layer.id = id;
      document.body.append(layer);
    }
    initLayers();
  }

  beforeEach(() => {
    setupLayers();
    resetStudioState();
  });

  test("Enter in the new-definition field confirms the dialog", async () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "li", textContent: "Item" }],
      state: {},
      tagName: "ul",
    } as never);
    tab.session.selection = ["children", 0];

    const done = convertToRepeater();
    await flush();
    const field = document.querySelector("#layer-dialog sp-textfield") as HTMLElement & {
      value?: string;
    };
    expect(field).not.toBeNull();
    field.value = "viaEnter";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await done;

    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.state as Record<string, unknown>).viaEnter).toEqual({ default: [], type: "array" });
    const child = (doc.children as Record<string, unknown>[])[0]!;
    expect(child.$prototype).toBe("Array");
    expect(child.items).toEqual({ $ref: "#/state/viaEnter" });
  });

  test("a selection whose parent has no children array leaves the doc untouched", async () => {
    const tab = resetWorkspaceWithTab({
      meta: { x: { tagName: "span", textContent: "loose" } },
      state: { rows: { default: [], type: "array" } },
      tagName: "div",
    } as never);
    tab.session.selection = ["meta", "x"];

    const done = convertToRepeater();
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper")!;
    expect(dialog).not.toBeNull();
    dialog.dispatchEvent(new Event("confirm"));
    await done;

    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.meta as Record<string, unknown>).x).toEqual({
      tagName: "span",
      textContent: "loose",
    });
  });
});

// ─── Context-menu clipboard ──────────────────────────────────────────────────

describe("context-menu clipboard gaps", () => {
  interface FakeReadItem {
    types: string[];
    getType: (t: string) => Promise<Blob>;
  }
  let readResult: FakeReadItem[] | null = null;

  function fakeItem(parts: Record<string, string>): FakeReadItem {
    return {
      getType: (t: string) => Promise.resolve(new Blob([parts[t]!], { type: t })),
      types: Object.keys(parts),
    };
  }

  const originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      read: () =>
        readResult
          ? Promise.resolve(readResult)
          : Promise.reject(new Error("clipboard read denied")),
    },
  });

  afterAll(() => {
    if (originalClipboardDesc) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDesc);
    } else {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  beforeEach(() => {
    readResult = null;
    workspace.clipboard = null;
    resetStudioState();
    resetWorkspaceWithTab({
      children: [
        { tagName: "p", textContent: "A" },
        { tagName: "p", textContent: "B" },
      ],
      tagName: "div",
    } as never);
  });

  function doc(): JxMutableNode {
    return activeTab.value!.doc.document;
  }

  test("text/html that converts to nothing falls through to text/plain", async () => {
    readResult = [fakeItem({ "text/html": "", "text/plain": "plain fallback" })];
    activeTab.value!.session.selection = ["children", 0];
    await pasteNode();
    const children = doc().children as Record<string, unknown>[];
    expect(children).toHaveLength(3);
    expect(children[1]).toMatchObject({ tagName: "p", textContent: "plain fallback" });
  });

  test("pasting onto a dangling selection is a no-op", async () => {
    readResult = [fakeItem({ "text/plain": "orphan" })];
    activeTab.value!.session.selection = ["children", 9];
    await pasteNode();
    expect(doc().children).toHaveLength(2);
  });
});

// ─── Context-menu conversion actions ─────────────────────────────────────────

describe("context-menu conversion actions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
      const layer = document.createElement("div");
      layer.id = id;
      document.body.append(layer);
    }
    initLayers();
    resetStudioState();
    resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "A" }],
      state: { rows: { default: [], type: "array" } },
      tagName: "div",
    } as never);
  });

  function clickItem(label: string) {
    const item = [...document.querySelectorAll("#layer-popover sp-menu-item")].find(
      (el) => el.textContent?.trim() === label,
    ) as HTMLElement;
    item.click();
  }

  function openMenu() {
    const e = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 20,
    });
    showContextMenu(e, ["children", 0]);
  }

  test("Repeat... opens the repeater dialog (cancel leaves the doc untouched)", async () => {
    openMenu();
    clickItem("Repeat...");
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper");
    expect(dialog).not.toBeNull();
    dialog!.dispatchEvent(new Event("cancel"));
    await flush();
    const child = (activeTab.value!.doc.document.children as Record<string, unknown>[])[0]!;
    expect(child.tagName).toBe("p");
    dismissContextMenu();
  });

  test("Convert to Component opens the name prompt (cancel leaves the doc untouched)", async () => {
    openMenu();
    clickItem("Convert to Component");
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper");
    expect(dialog).not.toBeNull();
    dialog!.dispatchEvent(new Event("cancel"));
    await flush();
    const child = (activeTab.value!.doc.document.children as Record<string, unknown>[])[0]!;
    expect(child.tagName).toBe("p");
    dismissContextMenu();
  });
});
