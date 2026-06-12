/**
 * Tests for src/editor/context-menu.ts — clipboard actions and the right-click context menu.
 *
 * Stubs navigator.clipboard / ClipboardItem to drive the copy/cut/paste flows (jx+json, text/html,
 * text/plain, and workspace fallback), then exercises the rendered menu structure and item actions
 * against a real tab document.
 */
import { flush, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyNode,
  copyStyles,
  cutNode,
  dismissContextMenu,
  pasteNode,
  pasteStyles,
  showContextMenu,
} from "../src/editor/context-menu";
import { componentRegistry } from "../src/files/components";
import { statusMessage } from "../src/panels/statusbar";
import { initLayers } from "../src/ui/layers";
import { activeTab, closeAllTabs, workspace } from "../src/workspace/workspace";

import type { JxPath } from "../src/state";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── Layer hosts ─────────────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
}
initLayers();

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

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll("#layer-popover sp-menu-item")] as HTMLElement[];
}

function menuLabels(): string[] {
  return menuItems().map((el) => el.textContent!.trim());
}

function itemByLabel(label: string): HTMLElement {
  const item = menuItems().find((el) => el.textContent!.trim() === label);
  if (!item) {
    throw new Error(`menu item not found: ${label}`);
  }
  return item;
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

beforeEach(() => {
  written = [];
  writtenText = [];
  readResult = null;
  writeMode = "ok";
  workspace.clipboard = null;
  workspace.styleClipboard = null;
  componentRegistry.length = 0;
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

// ─── Context menu rendering ──────────────────────────────────────────────────

describe("showContextMenu", () => {
  test("prevents default, selects the node, and renders the full child menu", () => {
    workspace.styleClipboard = { color: "blue" };
    const e = rightClick(["children", 0]);
    expect(e.defaultPrevented).toBe(true);
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
    expect(menuLabels()).toEqual([
      "Copy",
      "Cut",
      "Duplicate",
      "Copy styles",
      "Paste styles",
      "Insert before",
      "Insert after",
      "Wrap in Div",
      "Repeat...",
      "Set Title",
      "Convert to Component",
      "Delete",
      "Paste inside",
      "Paste after",
    ]);
    expect(document.querySelectorAll("#layer-popover sp-menu-divider").length).toBe(3);
  });

  test("root path renders only Copy", () => {
    rightClick([]);
    expect(menuLabels()).toEqual(["Copy"]);
  });

  test("omits Copy styles / Paste styles when unavailable", () => {
    rightClick(["children", 1]); // Node without style, empty style clipboard
    expect(menuLabels()).not.toContain("Copy styles");
    expect(menuLabels()).not.toContain("Paste styles");
  });

  test("does nothing without a tab or for a missing node", () => {
    rightClick(["children", 9]);
    expect(menuItems().length).toBe(0);

    closeAllTabs();
    rightClick(["children", 0]);
    expect(menuItems().length).toBe(0);
  });

  test("hides Repeat... for nodes already inside a repeater", () => {
    resetWorkspaceWithTab({
      children: [
        { children: { map: { tagName: "li", textContent: "i" } } as never, tagName: "ul" },
      ],
      tagName: "div",
    });
    rightClick(["children", 0, "children", "map"]);
    expect(menuLabels()).not.toContain("Repeat...");
    expect(menuLabels()).toContain("Delete");
  });

  test("Delete marks the item with the danger color", () => {
    rightClick(["children", 0]);
    expect(itemByLabel("Delete").getAttribute("style")).toContain("--danger");
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
    rightClick([]);
    expect(menuLabels()).toEqual(["Copy"]);
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
});

// ─── Context menu actions ────────────────────────────────────────────────────

describe("context menu actions", () => {
  test("Duplicate clones the node after itself and dismisses the menu", async () => {
    rightClick(["children", 0]);
    itemByLabel("Duplicate").click();
    await flush();
    expect(menuItems().length).toBe(0);
    const children = doc().children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[1]!.textContent).toBe("A");
  });

  test("Insert before / Insert after add empty paragraphs around the node", async () => {
    rightClick(["children", 0]);
    itemByLabel("Insert before").click();
    await flush();
    let children = doc().children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[0]).toEqual({ children: [], tagName: "p" });

    rightClick(["children", 1]); // Original "A" node
    itemByLabel("Insert after").click();
    await flush();
    children = doc().children as JxMutableNode[];
    expect(children.length).toBe(4);
    expect(children[2]).toEqual({ children: [], tagName: "p" });
  });

  test("Wrap in Div wraps the node", async () => {
    rightClick(["children", 0]);
    itemByLabel("Wrap in Div").click();
    await flush();
    const wrapper = (doc().children as JxMutableNode[])[0]!;
    expect(wrapper.tagName).toBe("div");
    expect((wrapper.children as JxMutableNode[])[0]!.textContent).toBe("A");
  });

  test("Delete removes the node", async () => {
    rightClick(["children", 0]);
    itemByLabel("Delete").click();
    await flush();
    const children = doc().children as JxMutableNode[];
    expect(children.length).toBe(1);
    expect(children[0]!.textContent).toBe("B");
  });

  test("Copy styles and Paste styles move styles between nodes", async () => {
    rightClick(["children", 0]);
    itemByLabel("Copy styles").click();
    await flush();
    expect(workspace.styleClipboard).toEqual({ color: "red" });

    rightClick(["children", 1]);
    itemByLabel("Paste styles").click();
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
    itemByLabel("Paste inside").click();
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
    itemByLabel("Paste inside").click();
    await flush();
    expect((doc().children as JxMutableNode[])[0]!.children).toBeUndefined();
  });

  test("Paste after inserts clipboard nodes as following siblings", async () => {
    readResult = [fakeItem({ "web application/jx+json": JSON.stringify({ tagName: "hr" }) })];
    rightClick(["children", 0]);
    itemByLabel("Paste after").click();
    await flush();
    expect((doc().children as JxMutableNode[])[1]).toEqual({ tagName: "hr" });
  });

  test("Paste after with an empty clipboard changes nothing", async () => {
    readResult = [];
    rightClick(["children", 0]);
    itemByLabel("Paste after").click();
    await flush();
    expect((doc().children as JxMutableNode[]).length).toBe(2);
  });

  test("Set Title without a rerender hook is a no-op", async () => {
    rightClick(["children", 0]);
    itemByLabel("Set Title").click();
    await flush();
    expect((doc().children as JxMutableNode[]).length).toBe(2);
  });

  test("Set Title with a rerender hook lazily loads the layers panel editor", async () => {
    rightClick(["children", 0], { rerender: () => {} });
    itemByLabel("Set Title").click();
    await flush(4); // Await the dynamic import; no .layer-row exists so it returns early
    expect((doc().children as JxMutableNode[]).length).toBe(2);
  });
});

// ─── Component-aware items ───────────────────────────────────────────────────

describe("component items", () => {
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
    expect(menuLabels()).toContain("Edit Component");
    expect(menuLabels()).not.toContain("Convert to Component");
    itemByLabel("Edit Component").click();
    await flush();
    expect(edited).toBe("components/card.json" as never);
  });

  test("components without an onEditComponent hook get neither item", () => {
    rightClick(["children", 0]);
    expect(menuLabels()).not.toContain("Edit Component");
    expect(menuLabels()).not.toContain("Convert to Component");
  });

  test("nodes without a tagName get neither component item", () => {
    rightClick(["children", 1]);
    expect(menuLabels()).not.toContain("Edit Component");
    expect(menuLabels()).not.toContain("Convert to Component");
  });
});
