/**
 * Tests for src/editor/context-menu.ts — the clipboard actions, the element command records, and
 * the context menu as a RENDERING of the command registry.
 *
 * Three things are asserted that the old hand-built literal could not have:
 *
 * - Every row's title, chord, destructive styling and disabled reason comes off the record;
 * - An inapplicable verb is greyed WITH its reason instead of vanishing;
 * - The menu has a real menu contract — role, roving tabindex, arrows, Escape, focus restore.
 *
 * `convert-to-repeater` / `convert-to-component` are mocked (they open their own dialogs and are
 * covered by their own suites), so the module under test is imported dynamically after the mocks.
 */
import { flush, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { componentRegistry } from "../src/files/components";
import { statusMessage } from "../src/panels/statusbar";
import { initLayers } from "../src/ui/layers";
import { activeTab, closeAllTabs, workspace } from "../src/workspace/workspace";
import { checkPlacements } from "../src/commands/levels";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext } from "../src/commands/context";

import type { ElementMenuTarget } from "../src/editor/context-menu";
import type { JxPath } from "../src/state";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";

// ─── Layer hosts ─────────────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
}
initLayers();

// ─── Module mocks ────────────────────────────────────────────────────────────

const convertToRepeater = mock(async () => {});
const convertToComponent = mock(async () => {});
void mock.module("../src/editor/convert-to-repeater.js", () => ({ convertToRepeater }));
void mock.module("../src/editor/convert-to-component.js", () => ({ convertToComponent }));

const {
  contextMenuRegistry,
  copyNode,
  copyStyles,
  cutNode,
  dismissContextMenu,
  elementCommands,
  pasteNode,
  pasteStyles,
  registerElementCommands,
  showContextMenu,
} = await import("../src/editor/context-menu");

// ─── Clipboard stubs ─────────────────────────────────────────────────────────

class FakeClipboardItem {
  parts: Record<string, Blob>;
  types: string[];
  constructor(parts: Record<string, Blob>) {
    this.parts = parts;
    this.types = Object.keys(parts);
  }
  getType(type: string) {
    return Promise.resolve(this.parts[type]!);
  }
}

interface FakeReadItem {
  types: string[];
  getType: (t: string) => Promise<Blob>;
}

let written: FakeClipboardItem[] = [];
let writtenText: string[] = [];
let readResult: FakeReadItem[] | null = null;
let writeMode: "ok" | "reject-write" | "reject-all" = "ok";

function fakeItem(parts: Record<string, string>) {
  return {
    getType: (t: string) => Promise.resolve(new Blob([parts[t]!], { type: t })),
    types: Object.keys(parts),
  };
}

const originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalClipboardItem = (globalThis as Record<string, unknown>).ClipboardItem;

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    read: () => {
      if (!readResult) {
        return Promise.reject(new Error("clipboard read denied"));
      }
      return Promise.resolve(readResult);
    },
    write: (items: FakeClipboardItem[]) => {
      if (writeMode !== "ok") {
        return Promise.reject(new Error("clipboard write denied"));
      }
      written.push(...items);
      return Promise.resolve();
    },
    writeText: (text: string) => {
      if (writeMode === "reject-all") {
        return Promise.reject(new Error("clipboard writeText denied"));
      }
      writtenText.push(text);
      return Promise.resolve();
    },
  },
});
(globalThis as Record<string, unknown>).ClipboardItem = FakeClipboardItem;

afterAll(async () => {
  if (originalClipboardDesc) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDesc);
  } else {
    delete (navigator as unknown as Record<string, unknown>).clipboard;
  }
  (globalThis as Record<string, unknown>).ClipboardItem = originalClipboardItem;
  statusMessage("", 1); // Drain the pending statusMessage timer
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
});

// ─── Shared fixtures ─────────────────────────────────────────────────────────

function makeDoc(): JxMutableNode {
  return {
    children: [
      { style: { color: "red" }, tagName: "p", textContent: "A" },
      { tagName: "p", textContent: "B" },
    ],
    tagName: "div",
  };
}

function select(path: JxPath | null) {
  activeTab.value!.session.selection = path as never;
}

function doc(): JxMutableNode {
  return activeTab.value!.doc.document;
}

/** Every rendered row, in order. Rows are addressed by command id, never by their label. */
function menuItems(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>("#layer-popover sp-menu-item[data-command-id]"),
  ];
}

function menuIds(): string[] {
  return menuItems().map((el) => el.dataset.commandId!);
}

function itemById(id: string): HTMLElement {
  const item = menuItems().find((el) => el.dataset.commandId === id);
  if (!item) {
    throw new Error(`menu row not found: ${id} (have: ${menuIds().join(", ")})`);
  }
  return item;
}

/** The row's own name — its direct text, with the chord and reason elements left out. */
function titleOf(id: string): string {
  return [...itemById(id).childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join("")
    .trim();
}

function chordOf(id: string): string | undefined {
  return itemById(id).querySelector("kbd")?.textContent ?? undefined;
}

function reasonOf(id: string): string | undefined {
  return itemById(id).querySelector('[slot="description"]')?.textContent ?? undefined;
}

function isDisabled(id: string): boolean {
  return itemById(id).hasAttribute("disabled");
}

function rightClick(path: JxPath, opts?: Parameters<typeof showContextMenu>[2]) {
  const e = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 20,
  });
  showContextMenu(e, path, opts);
  return e;
}

/** Press a key the way the document-level capture listener sees it. */
function menuKey(name: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: name, ...opts });
  document.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  written = [];
  writtenText = [];
  readResult = null;
  writeMode = "ok";
  workspace.clipboard = null;
  workspace.styleClipboard = null;
  componentRegistry.length = 0;
  convertToRepeater.mockClear();
  convertToComponent.mockClear();
  resetWorkspaceWithTab(makeDoc());
});

afterEach(() => {
  dismissContextMenu();
});

// ─── copyNode / nodeToHtml ───────────────────────────────────────────────────

describe("copyNode", () => {
  test("writes node JSON to workspace clipboard and system clipboard", async () => {
    select(["children", 0]);
    await copyNode();
    expect(workspace.clipboard).toEqual({
      style: { color: "red" },
      tagName: "p",
      textContent: "A",
    });
    expect(written.length).toBe(1);
    const json = JSON.parse(await written[0]!.parts["web application/jx+json"]!.text());
    expect(json.tagName).toBe("p");
  });

  test("serializes attributes, style, and quote escaping into text/html", async () => {
    resetWorkspaceWithTab({
      children: [
        {
          attributes: { "data-bound": { $ref: "#/x" } as never, hidden: "", title: 'a"b' },
          style: { color: "red", margin: "0" },
          tagName: "a",
          textContent: "hi",
        },
      ],
      tagName: "div",
    });
    select(["children", 0]);
    await copyNode();
    const htmlText = await written[0]!.parts["text/html"]!.text();
    expect(htmlText).toBe('<a hidden title="a&quot;b" style="color:red;margin:0">hi</a>');
  });

  test("serializes nested children including bare strings", async () => {
    resetWorkspaceWithTab({
      children: [
        { children: ["plain ", { tagName: "strong", textContent: "bold" }], tagName: "p" },
      ],
      tagName: "div",
    });
    select(["children", 0]);
    await copyNode();
    const htmlText = await written[0]!.parts["text/html"]!.text();
    expect(htmlText).toBe("<p>plain <strong>bold</strong></p>");
  });

  test("falls back to writeText when ClipboardItem write rejects", async () => {
    writeMode = "reject-write";
    select(["children", 1]);
    await copyNode();
    expect(written.length).toBe(0);
    expect(JSON.parse(writtenText[0]!)).toEqual({ tagName: "p", textContent: "B" });
    expect(workspace.clipboard).toEqual({ tagName: "p", textContent: "B" });
  });

  test("survives a completely unavailable clipboard API", async () => {
    writeMode = "reject-all";
    select(["children", 0]);
    await copyNode();
    expect(workspace.clipboard).not.toBeNull();
  });

  test("does nothing without a selection or without a node", async () => {
    select(null);
    await copyNode();
    expect(workspace.clipboard).toBeNull();

    select(["children", 9]);
    await copyNode();
    expect(workspace.clipboard).toBeNull();
  });
});

// ─── cutNode ─────────────────────────────────────────────────────────────────

describe("cutNode", () => {
  test("copies then removes the node from the document", async () => {
    select(["children", 0]);
    await cutNode();
    expect(workspace.clipboard).toEqual({
      style: { color: "red" },
      tagName: "p",
      textContent: "A",
    });
    const children = doc().children as JxMutableNode[];
    expect(children.length).toBe(1);
    expect(children[0]!.textContent).toBe("B");
  });

  test("refuses to cut the root or a missing node", async () => {
    select([]);
    await cutNode();
    expect((doc().children as JxMutableNode[]).length).toBe(2);

    select(["children", 9]);
    await cutNode();
    expect((doc().children as JxMutableNode[]).length).toBe(2);
  });
});

// ─── pasteNode ───────────────────────────────────────────────────────────────

describe("pasteNode", () => {
  test("pastes a jx+json clipboard item after the selection", async () => {
    readResult = [
      fakeItem({ "web application/jx+json": JSON.stringify({ tagName: "h2", textContent: "X" }) }),
    ];
    select(["children", 0]);
    await pasteNode();
    const children = doc().children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[1]).toEqual({ tagName: "h2", textContent: "X" });
  });

  test("converts text/html clipboard content via htmlToJx", async () => {
    readResult = [fakeItem({ "text/html": "<h3>Title</h3>" })];
    select(["children", 1]);
    await pasteNode();
    const children = doc().children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[2]!.tagName).toBe("h3");
  });

  test("parses text/plain JSON with a tagName as a node", async () => {
    readResult = [fakeItem({ "text/plain": JSON.stringify({ tagName: "em", textContent: "e" }) })];
    select(["children", 0]);
    await pasteNode();
    expect((doc().children as JxMutableNode[])[1]!.tagName).toBe("em");
  });

  test("wraps plain text in a paragraph", async () => {
    readResult = [fakeItem({ "text/plain": "  hello world  " })];
    select(["children", 0]);
    await pasteNode();
    expect((doc().children as JxMutableNode[])[1]).toEqual({
      tagName: "p",
      textContent: "hello world",
    });
  });

  test("whitespace-only text pastes nothing", async () => {
    readResult = [fakeItem({ "text/plain": "   " })];
    select(["children", 0]);
    await pasteNode();
    expect((doc().children as JxMutableNode[]).length).toBe(2);
  });

  test("appends to the root children when the root is selected", async () => {
    readResult = [
      fakeItem({ "web application/jx+json": JSON.stringify({ tagName: "h4", textContent: "Z" }) }),
    ];
    select([]);
    await pasteNode();
    const children = doc().children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[2]!.tagName).toBe("h4");
  });

  test("falls back to workspace.clipboard when the read API is unavailable", async () => {
    readResult = null;
    workspace.clipboard = { tagName: "blockquote", textContent: "fb" };
    select(["children", 0]);
    await pasteNode();
    expect((doc().children as JxMutableNode[])[1]!.tagName).toBe("blockquote");
  });

  test("does nothing when no clipboard data exists anywhere", async () => {
    readResult = null;
    select(["children", 0]);
    await pasteNode();
    expect((doc().children as JxMutableNode[]).length).toBe(2);
  });

  test("does nothing without an active tab", async () => {
    closeAllTabs();
    readResult = [fakeItem({ "text/plain": "x" })];
    await pasteNode(); // Must not throw
  });
});

// ─── copyStyles / pasteStyles ────────────────────────────────────────────────

describe("style clipboard", () => {
  test("copyStyles stores a clone of the node style", () => {
    select(["children", 0]);
    copyStyles();
    expect(workspace.styleClipboard).toEqual({ color: "red" });
    expect(workspace.styleClipboard).not.toBe(
      (doc().children as JxMutableNode[])[0]!.style as never,
    );
  });

  test("copyStyles is a no-op without style or selection", () => {
    select(["children", 1]); // No style
    copyStyles();
    expect(workspace.styleClipboard).toBeNull();

    select(null);
    copyStyles();
    expect(workspace.styleClipboard).toBeNull();
  });

  test("pasteStyles replaces the target node style", () => {
    workspace.styleClipboard = { fontWeight: "bold" };
    select(["children", 1]);
    pasteStyles();
    expect((doc().children as JxMutableNode[])[1]!.style).toEqual({ fontWeight: "bold" });
  });

  test("pasteStyles is a no-op without a style clipboard or selection", () => {
    select(["children", 1]);
    pasteStyles();
    expect((doc().children as JxMutableNode[])[1]!.style).toBeUndefined();

    workspace.styleClipboard = { color: "blue" };
    select(null);
    pasteStyles();
    expect((doc().children as JxMutableNode[])[1]!.style).toBeUndefined();
  });
});

// ─── The records themselves ──────────────────────────────────────────────────

function stubTarget(path: JxPath, node?: JxMutableNode): ElementMenuTarget {
  return { node: node ?? { tagName: "p" }, path };
}

function stubDeps(target: ElementMenuTarget | null = null, style: JxStyle | null = null) {
  return {
    componentPathFor: () => null,
    styleClipboard: () => style,
    target: () => target,
  };
}

describe("element command records", () => {
  test("every record satisfies the level × placement matrix", () => {
    const records = elementCommands(stubDeps());
    expect(checkPlacements(records)).toEqual([]);
  });

  test("every record is selection-level and declares the element menu", () => {
    for (const command of elementCommands(stubDeps())) {
      expect(command.level).toBe("selection");
      expect(command.menus).toContain("context/element");
      expect(command.requires).toBeTruthy();
    }
  });

  test("registerElementCommands defines them once — a second pass is a duplicate id", () => {
    const registry = createCommandRegistry({ getContext: emptyContext, mac: false });
    registerElementCommands(registry, stubDeps());
    expect(registry.list().length).toBe(elementCommands(stubDeps()).length);
    expect(() => registerElementCommands(registry, stubDeps())).toThrow(/duplicate command id/);
  });

  test("the chord index is the record's, formatted for the platform", () => {
    const registry = createCommandRegistry({ getContext: emptyContext, mac: true });
    registerElementCommands(registry, stubDeps());
    expect(registry.keymap.formatBinding("edit.copy")).toBe("⌘C");
    expect(registry.keymap.formatBinding("edit.pasteAfter")).toBe("⌘V");
    expect(registry.keymap.formatBinding("edit.copyStyles")).toBeUndefined();
  });

  test("structural verbs refuse a target with no splice coordinate", () => {
    const ctx = emptyContext();
    const onTemplate = elementCommands(stubDeps(stubTarget(["children", 0, "map"])));
    const cut = onTemplate.find((c) => c.id === "edit.cut")!;
    expect(cut.when!(ctx)).toBe(true);
    expect(cut.enablement!(ctx)).toBe(false);

    const onChild = elementCommands(stubDeps(stubTarget(["children", 0])));
    expect(onChild.find((c) => c.id === "edit.cut")!.enablement!(ctx)).toBe(true);
  });

  test("Repeat refuses a repeater and Paste inside refuses its child list", () => {
    const ctx = emptyContext();
    const onArray = elementCommands(
      stubDeps(stubTarget(["children", 0], { $prototype: "Array" } as JxMutableNode)),
    );
    expect(onArray.find((c) => c.id === "selection.repeat")!.enablement!(ctx)).toBe(false);
    expect(onArray.find((c) => c.id === "edit.pasteInside")!.enablement!(ctx)).toBe(false);
    expect(onArray.find((c) => c.id === "edit.pasteAfter")!.enablement!(ctx)).toBe(false);
  });

  test("Set Title hides without the surface hook it needs to edit into", () => {
    const ctx = emptyContext();
    const noHook = elementCommands(stubDeps(stubTarget(["children", 0])));
    expect(noHook.find((c) => c.id === "selection.setTitle")!.when!(ctx)).toBe(false);

    const withHook = elementCommands(
      stubDeps({ ...stubTarget(["children", 0]), rerender: () => {} }),
    );
    expect(withHook.find((c) => c.id === "selection.setTitle")!.when!(ctx)).toBe(true);
  });

  test("every run is inert without a target", async () => {
    const commands = elementCommands(stubDeps());
    const ctx = emptyContext();
    for (const command of commands) {
      await command.run(ctx, undefined as never);
    }
    expect(doc().children).toHaveLength(2);
  });
});

// ─── Context menu rendering ──────────────────────────────────────────────────

describe("showContextMenu", () => {
  test("prevents default, selects the node, and renders the registry's element rows", () => {
    workspace.styleClipboard = { color: "blue" };
    const e = rightClick(["children", 0]);
    expect(e.defaultPrevented).toBe(true);
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
    // Group order, then title order — the registry's sort, not a hand-kept array.
    expect(menuIds()).toEqual([
      "edit.copy",
      "edit.cut",
      "edit.pasteAfter",
      "edit.pasteInside",
      "edit.copyStyles",
      "edit.pasteStyles",
      "selection.duplicate",
      "selection.insertAfter",
      "selection.insertBefore",
      "selection.repeat",
      "selection.wrap",
      "selection.convertToComponent",
      "selection.delete",
    ]);
    // One divider per group boundary: clipboard | styles | structure | identity | danger.
    expect(document.querySelectorAll("#layer-popover sp-menu-divider").length).toBe(4);
  });

  test("the menu carries the ARIA menu contract", () => {
    rightClick(["children", 0]);
    const menu = document.querySelector("#layer-popover sp-menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-label")).toBe("Element actions");
    for (const item of menuItems()) {
      expect(item.getAttribute("role")).toBe("menuitem");
    }
  });

  test("rows print the record's title and its chord", () => {
    rightClick(["children", 0]);
    expect(titleOf("edit.copy")).toBe("Copy");
    expect(chordOf("edit.copy")).toBe("Ctrl+C");
    expect(chordOf("edit.cut")).toBe("Ctrl+X");
    expect(chordOf("selection.duplicate")).toBe("Ctrl+D");
    // An unbound verb prints no chord…
    expect(chordOf("selection.wrap")).toBeUndefined();
    // …and neither does one whose chord just restates its name.
    expect(titleOf("selection.delete")).toBe("Delete");
    expect(chordOf("selection.delete")).toBeUndefined();
  });

  test("destructive styling comes off the record, not the call site", () => {
    rightClick(["children", 0]);
    expect(itemById("selection.delete").getAttribute("style")).toContain("--danger");
    expect(itemById("edit.copy").getAttribute("style")).toBe("");
  });

  test("an inapplicable verb greys out WITH its reason instead of vanishing", () => {
    rightClick(["children", 1]); // No style on this node, and nothing in the style clipboard
    expect(menuIds()).toContain("edit.copyStyles");
    expect(isDisabled("edit.copyStyles")).toBe(true);
    expect(reasonOf("edit.copyStyles")).toBe("Needs styles on the selected element");
    expect(isDisabled("edit.pasteStyles")).toBe(true);
    expect(reasonOf("edit.pasteStyles")).toBe("Needs a copied style set");
    expect(isDisabled("edit.copy")).toBe(false);
    expect(reasonOf("edit.copy")).toBeUndefined();
  });

  test("the document root keeps Copy and explains every structural refusal", () => {
    rightClick([]);
    expect(isDisabled("edit.copy")).toBe(false);
    expect(isDisabled("edit.cut")).toBe(true);
    expect(isDisabled("selection.delete")).toBe(true);
    expect(reasonOf("selection.delete")).toBe(
      "Needs an element selection that is not the document root",
    );
    expect(reasonOf("selection.wrap")).toContain("sibling position");
  });

  test("a repeater template is unspliceable too, so Delete stays disabled", () => {
    resetWorkspaceWithTab({
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/rows" },
          map: { tagName: "li", textContent: "i" },
        } as never,
      ],
      state: { rows: { default: [], type: "array" } },
      tagName: "div",
    });
    // The repeater itself is a real child: deletable, but not repeatable and not a paste target.
    rightClick(["children", 0]);
    expect(isDisabled("selection.delete")).toBe(false);
    expect(isDisabled("selection.repeat")).toBe(true);
    expect(isDisabled("edit.pasteInside")).toBe(true);

    // The template (path tail "map") has no numeric child index — splicing it would hit NaN.
    rightClick(["children", 0, "map"]);
    expect(isDisabled("selection.delete")).toBe(true);
    expect(isDisabled("edit.cut")).toBe(true);
    expect(isDisabled("edit.copy")).toBe(false);
  });

  test("does nothing without a tab or for a missing node", () => {
    rightClick(["children", 9]);
    expect(menuItems().length).toBe(0);

    closeAllTabs();
    rightClick(["children", 0]);
    expect(menuItems().length).toBe(0);
  });

  test("dismissContextMenu removes the menu and is safe when closed", () => {
    rightClick(["children", 0]);
    expect(menuItems().length).toBeGreaterThan(0);
    dismissContextMenu();
    expect(menuItems().length).toBe(0);
    dismissContextMenu(); // No handle — must not throw
  });

  test("an outside mousedown dismisses the menu", async () => {
    rightClick(["children", 0]);
    await flush(); // RAF registers the outside-click listener
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menuItems().length).toBe(0);
  });

  test("reopening replaces the previous menu", () => {
    rightClick(["children", 0]);
    rightClick(["children", 1]);
    expect(document.querySelectorAll("#layer-popover sp-menu").length).toBe(1);
  });

  test("clamps the popover position to the window after layout", async () => {
    const e = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: window.innerWidth - 10,
      clientY: window.innerHeight - 10,
    });
    showContextMenu(e, ["children", 0]);
    const popover = document.querySelector("#layer-popover sp-popover") as HTMLElement;
    stubRect(popover, { height: 200, left: window.innerWidth - 10, top: 0, width: 300 });
    await flush();
    expect(popover.style.left).toBe(`${window.innerWidth - 300 - 4}px`);
    expect(popover.style.top).toBe(`${window.innerHeight - 200 - 4}px`);
  });

  test("an unknown placement renders nothing and leaves no target behind", () => {
    rightClick(["children", 0], { placement: "context/file" });
    expect(menuItems().length).toBe(0);
    // The registry must not still think a menu is open over the node.
    expect(contextMenuRegistry().isVisible("edit.copy")).toBe(false);
  });
});

// ─── The menu keyboard contract ──────────────────────────────────────────────

describe("menu keyboard", () => {
  function focusedId(): string | undefined {
    return (document.activeElement as HTMLElement | null)?.dataset?.commandId;
  }

  test("opens with the first row focused and a roving tabindex", async () => {
    rightClick(["children", 0]);
    await flush();
    expect(focusedId()).toBe("edit.copy");
    expect(itemById("edit.copy").getAttribute("tabindex")).toBe("0");
    expect(itemById("edit.cut").getAttribute("tabindex")).toBe("-1");
    expect(itemById("edit.copy").hasAttribute("focused")).toBe(true);
  });

  test("Down / Up / Home / End move the roving focus and wrap", async () => {
    rightClick(["children", 0]);
    await flush();
    const ids = menuIds();

    menuKey("ArrowDown");
    expect(focusedId()).toBe(ids[1]);
    menuKey("ArrowUp");
    expect(focusedId()).toBe(ids[0]);
    menuKey("ArrowUp"); // Wraps to the end
    expect(focusedId()).toBe(ids.at(-1));
    menuKey("Home");
    expect(focusedId()).toBe(ids[0]);
    menuKey("End");
    expect(focusedId()).toBe(ids.at(-1));
    menuKey("ArrowDown"); // Wraps to the start
    expect(focusedId()).toBe(ids[0]);
    expect(itemById(ids[0]!).getAttribute("tabindex")).toBe("0");
  });

  test("navigation keys are swallowed so the canvas does not also move", async () => {
    rightClick(["children", 0]);
    await flush();
    expect(menuKey("ArrowDown").defaultPrevented).toBe(true);
    // An unhandled key falls through to the app untouched.
    expect(menuKey("a").defaultPrevented).toBe(false);
  });

  test("Enter runs the focused row", async () => {
    rightClick(["children", 0]);
    await flush();
    menuKey("End"); // Lands on selection.delete, the last row
    expect(focusedId()).toBe("selection.delete");
    menuKey("Enter");
    await flush();
    expect(menuItems().length).toBe(0);
    expect(doc().children).toHaveLength(1);
  });

  test("Space runs the focused row too", async () => {
    rightClick(["children", 0]);
    await flush();
    menuKey(" ");
    await flush();
    expect(menuItems().length).toBe(0);
    expect(workspace.clipboard).not.toBeNull();
  });

  test("Enter on a disabled row does nothing and leaves the menu up", async () => {
    rightClick(["children", 1]); // Paste styles is disabled here
    await flush();
    const at = menuIds().indexOf("edit.pasteStyles");
    for (let i = 0; i < at; i++) {
      menuKey("ArrowDown");
    }
    expect(focusedId()).toBe("edit.pasteStyles");
    menuKey("Enter");
    await flush();
    expect(menuItems().length).toBeGreaterThan(0);
  });

  test("clicking a disabled row does nothing", async () => {
    rightClick(["children", 1]);
    await flush();
    itemById("edit.pasteStyles").click();
    await flush();
    expect((doc().children as JxMutableNode[])[1]!.style).toBeUndefined();
  });

  test("Escape dismisses and hands the keyboard back to the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    rightClick(["children", 0]);
    await flush();
    expect(focusedId()).toBe("edit.copy");
    const e = menuKey("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(menuItems().length).toBe(0);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test("Tab dismisses rather than walking out of the menu", async () => {
    rightClick(["children", 0]);
    await flush();
    menuKey("Tab");
    expect(menuItems().length).toBe(0);
    // The listener is gone with the menu: a later key must not be swallowed.
    expect(menuKey("ArrowDown").defaultPrevented).toBe(false);
  });

  test("a dismissed menu leaves focus alone when the opener is gone", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    rightClick(["children", 0]);
    await flush();
    opener.remove();
    menuKey("Escape");
    expect(document.activeElement).not.toBe(opener);
  });
});

// ─── Row actions ─────────────────────────────────────────────────────────────

describe("context menu actions", () => {
  test("Duplicate clones the node after itself and dismisses the menu", async () => {
    rightClick(["children", 0]);
    itemById("selection.duplicate").click();
    await flush();
    expect(menuItems().length).toBe(0);
    const children = doc().children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[1]!.textContent).toBe("A");
  });

  test("Duplicate on the page root reports why it cannot, instead of corrupting the document", () => {
    // `selection.duplicate` (commands/defaults.ts) declares no `enablement`, so it renders enabled
    // Even where there is no splice coordinate. Until it gains one the injected implementation
    // Refuses out loud — splicing at a non-numeric index would remove the WRONG child.
    rightClick([]);
    itemById("selection.duplicate").click();
    expect(doc().children).toHaveLength(2);
  });

  test("Insert before / Insert after add empty paragraphs around the node", async () => {
    rightClick(["children", 0]);
    itemById("selection.insertBefore").click();
    await flush();
    let children = doc().children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[0]).toEqual({ children: [], tagName: "p" });

    rightClick(["children", 1]); // Original "A" node
    itemById("selection.insertAfter").click();
    await flush();
    children = doc().children as JxMutableNode[];
    expect(children.length).toBe(4);
    expect(children[2]).toEqual({ children: [], tagName: "p" });
  });

  test("Wrap in Div wraps the node", async () => {
    rightClick(["children", 0]);
    itemById("selection.wrap").click();
    await flush();
    const wrapper = (doc().children as JxMutableNode[])[0]!;
    expect(wrapper.tagName).toBe("div");
    expect((wrapper.children as JxMutableNode[])[0]!.textContent).toBe("A");
  });

  test("Delete removes the node", async () => {
    rightClick(["children", 0]);
    itemById("selection.delete").click();
    await flush();
    const children = doc().children as JxMutableNode[];
    expect(children.length).toBe(1);
    expect(children[0]!.textContent).toBe("B");
  });

  test("Cut copies then removes", async () => {
    rightClick(["children", 0]);
    itemById("edit.cut").click();
    await flush();
    expect(workspace.clipboard).toMatchObject({ textContent: "A" });
    expect(doc().children).toHaveLength(1);
  });

  test("Copy writes the node to the clipboard", async () => {
    rightClick(["children", 1]);
    itemById("edit.copy").click();
    await flush();
    expect(workspace.clipboard).toMatchObject({ textContent: "B" });
  });

  test("Copy styles and Paste styles move styles between nodes", async () => {
    rightClick(["children", 0]);
    itemById("edit.copyStyles").click();
    await flush();
    expect(workspace.styleClipboard).toEqual({ color: "red" });

    rightClick(["children", 1]);
    itemById("edit.pasteStyles").click();
    await flush();
    expect((doc().children as JxMutableNode[])[1]!.style).toEqual({ color: "red" });
  });

  test("Paste inside appends clipboard nodes into the node", async () => {
    readResult = [
      fakeItem({
        "web application/jx+json": JSON.stringify({ tagName: "span", textContent: "i" }),
      }),
    ];
    rightClick(["children", 0]);
    itemById("edit.pasteInside").click();
    await flush();
    const target = (doc().children as JxMutableNode[])[0]!;
    expect((target.children as JxMutableNode[])[0]).toEqual({
      tagName: "span",
      textContent: "i",
    });
  });

  test("Paste inside with an empty clipboard changes nothing", async () => {
    readResult = [];
    rightClick(["children", 0]);
    itemById("edit.pasteInside").click();
    await flush();
    expect((doc().children as JxMutableNode[])[0]!.children).toBeUndefined();
  });

  test("Paste after inserts clipboard nodes as following siblings", async () => {
    readResult = [fakeItem({ "web application/jx+json": JSON.stringify({ tagName: "hr" }) })];
    rightClick(["children", 0]);
    itemById("edit.pasteAfter").click();
    await flush();
    expect((doc().children as JxMutableNode[])[1]).toEqual({ tagName: "hr" });
  });

  test("Paste after with an empty clipboard changes nothing", async () => {
    readResult = [];
    rightClick(["children", 0]);
    itemById("edit.pasteAfter").click();
    await flush();
    expect((doc().children as JxMutableNode[]).length).toBe(2);
  });

  test("Repeat... delegates to the repeater conversion", async () => {
    rightClick(["children", 0]);
    // The screenshot manifest reaches this row by its exact text through `element.repeat`.
    expect(itemById("selection.repeat").textContent!.replaceAll(/\s+/g, " ").trim()).toBe(
      "Repeat...",
    );
    itemById("selection.repeat").click();
    await flush();
    expect(convertToRepeater).toHaveBeenCalledTimes(1);
  });

  test("Convert to Component delegates to the component conversion", async () => {
    rightClick(["children", 0]);
    itemById("selection.convertToComponent").click();
    await flush();
    expect(convertToComponent).toHaveBeenCalledTimes(1);
  });

  test("Set Title with a rerender hook lazily loads the layers panel editor", async () => {
    rightClick(["children", 0], { rerender: () => {} });
    itemById("selection.setTitle").click();
    await flush(4); // Await the dynamic import; no .layer-row exists so it returns early
    expect((doc().children as JxMutableNode[]).length).toBe(2);
  });
});

// ─── Component-aware rows ────────────────────────────────────────────────────

describe("component rows", () => {
  beforeEach(() => {
    componentRegistry.push({ path: "components/card.json", tagName: "x-card" } as never);
    resetWorkspaceWithTab({
      children: [{ tagName: "x-card" }, { textContent: "no tag" }],
      tagName: "div",
    });
  });

  test("registered components get Edit Component instead of Convert to Component", async () => {
    let edited: string | null = null;
    rightClick(["children", 0], { onEditComponent: (p) => (edited = p) });
    expect(menuIds()).toContain("selection.editComponent");
    expect(menuIds()).not.toContain("selection.convertToComponent");
    itemById("selection.editComponent").click();
    await flush();
    expect(edited).toBe("components/card.json" as never);
  });

  test("components without an onEditComponent hook get neither row", () => {
    rightClick(["children", 0]);
    expect(menuIds()).not.toContain("selection.editComponent");
    expect(menuIds()).not.toContain("selection.convertToComponent");
  });

  test("nodes without a tagName get neither row", () => {
    rightClick(["children", 1]);
    expect(menuIds()).not.toContain("selection.editComponent");
    expect(menuIds()).not.toContain("selection.convertToComponent");
  });
});
