/**
 * Tests for src/panels/block-action-bar.ts — the floating action bar above the selected element.
 *
 * The bar now drives its format state + position across the iframe bridge (Phase 4b-2): selection
 * structure (badge/parent/move/convert/drag) comes from the doc + a mocked `getEditBarAnchorRect`,
 * pressed-state from a mocked `getEditSnapshot`, and format/link/merge-tag clicks post intents via
 * a mocked `postApplyFormat`. The parent never reads the iframe DOM. `../src/canvas/iframe-host` is
 * mocked so the three bridge functions are controllable per test.
 */
import { flush, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getConvertTargets } from "../src/editor/convert-targets";
import { dismissSlashMenu, isSlashMenuOpen } from "../src/editor/slash-menu";
import { componentRegistry } from "../src/files/components";
import { initLayers } from "../src/ui/layers";
import { view } from "../src/view";
import { activeTab } from "../src/workspace/workspace";

import type { JxPath } from "../src/state";
import type { JxMutableNode, JxStateDefinition } from "@jxsuite/schema/types";
import type { ApplyFormatIntent, SelectionSnapshot } from "../src/canvas/iframe-protocol";

// ─── DnD adapter mock (must precede the module-under-test import) ────────────

const dnd: { draggables: { element: HTMLElement; getInitialData: () => unknown }[] } = {
  draggables: [],
};

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: (opts: { element: HTMLElement; getInitialData: () => unknown }) => {
    dnd.draggables.push(opts);
    return () => {};
  },
}));

// ─── iframe-host bridge mock — controllable edit snapshot / anchor / applyFormat ─────

interface HostMock {
  editing: boolean;
  snapshot: SelectionSnapshot | null;
  anchor: { left: number; top: number; width: number; height: number } | null;
  posted: ApplyFormatIntent[];
}
const host: HostMock = { anchor: null, editing: false, posted: [], snapshot: null };

void mock.module("../src/canvas/iframe-host", () => ({
  getEditBarAnchorRect: () => host.anchor,
  getEditSnapshot: () => ({ editing: host.editing, snapshot: host.snapshot }),
  postApplyFormat: (intent: ApplyFormatIntent) => host.posted.push(intent),
}));

const {
  dismissBlockActionBar,
  dismissLinkPopover,
  handleParentFormatShortcut,
  initBlockActionBar,
  renderBlockActionBar,
} = await import("../src/panels/block-action-bar");

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

/** Make a selection snapshot with the given active tags / collapsed / link state. */
function snapshotOf(overrides: Partial<SelectionSnapshot> = {}): SelectionSnapshot {
  return {
    activeTags: [],
    collapsed: false,
    kind: "selectionChanged",
    link: { active: false, href: null },
    localScope: null,
    path: [],
    rect: { height: 12, width: 30, x: 0, y: 0 },
    seq: 1,
    ...overrides,
  };
}

/** Place the toolbar anchor (parent-viewport space). Default keeps it well below the 80px headroom. */
function setAnchor(
  rect: Partial<{ left: number; top: number; width: number; height: number }> = {},
) {
  host.anchor = { height: 20, left: 30, top: 200, width: 100, ...rect };
}

function setup(docNode: JxMutableNode, selection: JxPath | null) {
  const tab = resetWorkspaceWithTab(docNode);
  tab.session.selection = selection as never;
  setAnchor();
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

/** Put the bar into the editing state with a snapshot (default: non-collapsed, no active tags). */
function startEditingState(snapshot: Partial<SelectionSnapshot> = {}) {
  host.editing = true;
  host.snapshot = snapshotOf(snapshot);
  renderBlockActionBar();
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
    host.editing = false;
    host.snapshot = null;
    host.anchor = null;
    host.posted.length = 0;
  });

  afterEach(() => {
    dismissSlashMenu();
    dismissLinkPopover();
    dismissBlockActionBar();
    if (view.selDragCleanup) {
      view.selDragCleanup();
      view.selDragCleanup = null;
    }
  });

  // ─── Dismissal conditions ──────────────────────────────────────────────────

  test("renders nothing outside design/edit modes, without selection, or without an anchor", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);

    canvasMode = "preview";
    renderBlockActionBar();
    expect(bar()).toBeNull();

    canvasMode = "design";
    activeTab.value!.session.selection = null as never;
    renderBlockActionBar();
    expect(bar()).toBeNull();

    activeTab.value!.session.selection = ["children", 0] as never;
    host.anchor = null; // No anchor rect from the bridge → nothing to position from.
    renderBlockActionBar();
    expect(bar()).toBeNull();
  });

  test("renders nothing when the selected doc node does not exist", () => {
    setup({ children: [], tagName: "div" }, ["children", 0]);
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
  });

  test("positions from the bridge anchor rect (viewport space), above when there is headroom", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    setAnchor({ height: 50, left: 30, top: 200, width: 100 });
    renderBlockActionBar();
    const style = bar()!.getAttribute("style")!;
    expect(style).toContain("left:30px");
    expect(style).toContain("top:162px"); // 200 - 38
  });

  test("positions below the anchor when near the top of the viewport", () => {
    setup({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" }, ["children", 0]);
    setAnchor({ height: 20, left: 12, top: 10, width: 100 });
    renderBlockActionBar();
    const style = bar()!.getAttribute("style")!;
    expect(style).toContain("left:12px");
    expect(style).toContain("top:34px"); // 10 + 20 + 4
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

  // ─── Inline formatting (snapshot-driven) ───────────────────────────────────

  test("format buttons appear only while editing, with shortcuts in their titles", () => {
    setup({ children: [{ tagName: "p", textContent: "hello" }], tagName: "div" }, ["children", 0]);
    renderBlockActionBar();
    expect(bar()!.querySelector("sp-action-group")).toBeNull(); // Not editing

    startEditingState();
    const group = bar()!.querySelector("sp-action-group")!;
    const titles = [...group.querySelectorAll("sp-action-button")].map((b) =>
      b.getAttribute("title"),
    );
    expect(titles).toContain("Bold (Cmd+B)");
    expect(titles).toContain("Underline");
    expect(titles.length).toBe(8); // P inline actions
  });

  test("pressed-state comes from the snapshot's activeTags", () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    startEditingState({ activeTags: ["strong"] });
    const selected = bar()!.querySelector("sp-action-group")!.getAttribute("selected");
    expect(JSON.parse(selected!)).toEqual(["strong"]);
  });

  test("a Bold click posts an applyFormat bold intent across the bridge", () => {
    setup({ children: [{ tagName: "p", textContent: "hello" }], tagName: "div" }, ["children", 0]);
    startEditingState();
    barButton("Bold").click();
    expect(host.posted).toEqual([{ command: "bold" }]);
  });

  test("a collapsed caret disables format buttons (link stays enabled)", () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    startEditingState({ collapsed: true });
    expect(barButton("Bold").hasAttribute("disabled")).toBe(true);
    expect(barButton("Link").hasAttribute("disabled")).toBe(false);
  });

  test("format button mousedown is prevented (focus guard)", () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    startEditingState();
    const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    barButton("Bold").dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  // ─── Merge tags ──────────────────────────────────────────────────────────

  function setupEditingWithState(state: Record<string, JxStateDefinition>) {
    setup({ children: [{ tagName: "p", textContent: "hello" }], state, tagName: "div" }, [
      "children",
      0,
    ]);
    startEditingState();
  }

  test("Insert data button is absent when not editing", () => {
    setup(
      { children: [{ tagName: "p", textContent: "A" }], state: { title: "x" }, tagName: "div" },
      ["children", 0],
    );
    renderBlockActionBar();
    expect(bar()!.querySelector('sp-action-button[title="Insert data"]')).toBeNull();
  });

  test("Insert data button appears while editing and opens a merge-tag menu", () => {
    setupEditingWithState({ count: 5, title: "Hello" });
    const btn = barButton("Insert data");
    expect(btn.querySelector("sp-icon-data")).not.toBeNull();

    btn.click();
    expect(isSlashMenuOpen()).toBe(true);
    // Two top-level state names → two merge tags (no live scope → no nested walk).
    expect(document.querySelectorAll("sp-menu-item").length).toBe(2);
  });

  test("selecting a merge tag posts an insertData intent", async () => {
    setupEditingWithState({ title: "Hello" });
    barButton("Insert data").click();
    expect(isSlashMenuOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush();
    expect(isSlashMenuOpen()).toBe(false);
    expect(host.posted).toEqual([{ command: "insertData", token: "state.title" }]);
  });

  // ─── Link popover ──────────────────────────────────────────────────────────

  test("Link button opens the popover; Apply posts a link intent", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    startEditingState();

    barButton("Link").click();
    const popoverHost = linkPopoverHost()!;
    expect(popoverHost.querySelector("sp-popover.link-popover")).not.toBeNull();
    const field = popoverHost.querySelector("sp-textfield") as HTMLInputElement;
    expect(field.getAttribute("value")).toBe("");
    const buttons = [...popoverHost.querySelectorAll("sp-action-button")];
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(["Apply"]);

    field.value = "https://example.com";
    (buttons[0] as HTMLElement).click();
    await flush();
    expect(host.posted).toEqual([{ command: "link", href: "https://example.com" }]);
    expect(linkPopoverHost()).toBeNull();
  });

  test("inside an existing link the popover prefills and offers Update + Remove", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    startEditingState({ link: { active: true, href: "https://old" } });

    barButton("Link").click();
    let popoverHost = linkPopoverHost()!;
    const field = popoverHost.querySelector("sp-textfield") as HTMLInputElement;
    expect(field.getAttribute("value")).toBe("https://old");
    const labels = [...popoverHost.querySelectorAll("sp-action-button")].map((b) =>
      b.textContent!.trim(),
    );
    expect(labels).toEqual(["Update", "Remove"]);

    // Update posts a link intent with the new href.
    field.value = "https://new";
    (popoverHost.querySelectorAll("sp-action-button")[0] as HTMLElement).click();
    await flush();
    expect(host.posted).toEqual([{ command: "link", href: "https://new" }]);
    expect(linkPopoverHost()).toBeNull();

    // Reopen and Remove posts a null-href link intent.
    host.posted.length = 0;
    barButton("Link").click();
    popoverHost = linkPopoverHost()!;
    (popoverHost.querySelectorAll("sp-action-button")[1] as HTMLElement).click();
    await flush();
    expect(host.posted).toEqual([{ command: "link", href: null }]);
  });

  test("Enter applies and Escape dismisses from the URL field", async () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    startEditingState();

    barButton("Link").click();
    let field = linkPopoverHost()!.querySelector("sp-textfield") as HTMLInputElement;
    field.value = "https://kbd.example";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush();
    expect(host.posted).toEqual([{ command: "link", href: "https://kbd.example" }]);
    expect(linkPopoverHost()).toBeNull();

    host.posted.length = 0;
    barButton("Link").click();
    field = linkPopoverHost()!.querySelector("sp-textfield") as HTMLInputElement;
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await flush();
    expect(linkPopoverHost()).toBeNull();
    expect(host.posted).toEqual([]); // Escape did not apply
  });

  test("an open link popover is preserved across a snapshot-driven re-render", () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    startEditingState();
    barButton("Link").click();
    expect(linkPopoverHost()).not.toBeNull();

    // A snapshot-driven refresh must NOT re-mount (and so clobber) the open popover.
    const fieldBefore = linkPopoverHost()!.querySelector("sp-textfield");
    renderBlockActionBar();
    expect(linkPopoverHost()).not.toBeNull();
    expect(linkPopoverHost()!.querySelector("sp-textfield")).toBe(fieldBefore);
  });

  test("dismissLinkPopover clears the popover slot", () => {
    setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
    startEditingState();
    barButton("Link").click();
    expect(linkPopoverHost()).not.toBeNull();
    dismissLinkPopover();
    expect(linkPopoverHost()).toBeNull();
  });

  // ─── Parent-focus format shortcuts (Ctrl+B etc.) ───────────────────────────

  describe("handleParentFormatShortcut", () => {
    function ctrl(key: string) {
      return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key });
    }

    test("editing + parent-focused: Ctrl+B posts an applyFormat bold intent", () => {
      host.editing = true;
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      const e = ctrl("b");
      handleParentFormatShortcut(e);
      expect(host.posted).toEqual([{ command: "bold" }]);
      expect(e.defaultPrevented).toBe(true);
      input.remove();
    });

    test("Ctrl+I and Ctrl+` post italic/code", () => {
      host.editing = true;
      handleParentFormatShortcut(ctrl("i"));
      handleParentFormatShortcut(ctrl("`"));
      expect(host.posted).toEqual([{ command: "italic" }, { command: "code" }]);
    });

    test("Ctrl+K opens the link popover (anchored to the bar's Link button)", () => {
      setup({ children: [{ tagName: "p", textContent: "hi" }], tagName: "div" }, ["children", 0]);
      startEditingState();
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();

      handleParentFormatShortcut(ctrl("k"));
      expect(linkPopoverHost()).not.toBeNull();
      input.remove();
    });

    test("does nothing when not editing", () => {
      host.editing = false;
      handleParentFormatShortcut(ctrl("b"));
      expect(host.posted).toEqual([]);
    });

    test("ignores chords without ctrl/meta or with alt held", () => {
      host.editing = true;
      handleParentFormatShortcut(
        new KeyboardEvent("keydown", { altKey: true, ctrlKey: true, key: "b" }),
      );
      handleParentFormatShortcut(new KeyboardEvent("keydown", { key: "b" }));
      expect(host.posted).toEqual([]);
    });

    test("does nothing when focus is inside the canvas iframe", () => {
      host.editing = true;
      const iframe = document.createElement("iframe");
      iframe.className = "jx-canvas-iframe";
      document.body.append(iframe);
      iframe.focus();
      // Force activeElement to the iframe (happy-dom focus on iframe).
      Object.defineProperty(document, "activeElement", { configurable: true, value: iframe });
      handleParentFormatShortcut(ctrl("b"));
      expect(host.posted).toEqual([]);
      delete (document as unknown as Record<string, unknown>).activeElement;
      iframe.remove();
    });
  });
});
