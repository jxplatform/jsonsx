/**
 * Tests for src/editor/shortcuts.ts — keyboard, wheel, and pointer shortcuts.
 *
 * Mocks quick-search and context-menu (their own behavior is covered elsewhere) so the test
 * exercises the shortcut dispatch logic itself: wheel zoom/pan, middle-mouse pan, and the
 * document-level keydown router.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Module mocks (must precede the shortcuts import) ─────────────────────────

const openQuickSearch = mock(() => {});
void mock.module("../src/panels/quick-search.js", () => ({ openQuickSearch }));

const copyNode = mock(async () => {});
const cutNode = mock(async () => {});
const pasteNode = mock(async () => {});
void mock.module("../src/editor/context-menu.js", () => ({ copyNode, cutNode, pasteNode }));

const { initShortcuts } = await import("../src/editor/shortcuts");
const store = await import("../src/store");
const { initShellRefs } = store;
const { activeTab, openTab, workspace } = await import("../src/workspace/workspace");
const { initLayers } = await import("../src/ui/layers");
const { startEditing, isEditing, stopEditing } = await import("../src/editor/inline-edit");

// ─── Environment setup ────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

/** Live accessor — store.canvasWrap is assigned by initShellRefs() in beforeAll. */
function wrapEl(): HTMLElement {
  return store.canvasWrap;
}

// ─── Shortcut context (mutable; read by getContext on every event) ────────────

let canvasMode = "design";
let panX = 0;
let panY = 0;
const setPan = mock((x: number, y: number) => {
  panX = x;
  panY = y;
});
const applyTransform = mock(() => {});
const positionZoomIndicator = mock(() => {});
const saveFile = mock(() => {});
const openProject = mock(() => {});

function freshDoc() {
  return {
    children: [
      { tagName: "p", textContent: "one" },
      { children: [{ tagName: "span", textContent: "inner" }], tagName: "div" },
      { tagName: "p", textContent: "three" },
    ],
    tagName: "div",
  };
}

beforeAll(() => {
  document.body.innerHTML = "";
  for (const id of [
    "canvas-wrap",
    "activity-bar",
    "left-panel",
    "right-panel",
    "toolbar",
    "statusbar",
    "layer-popover",
    "layer-modal",
    "layer-dialog",
  ]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
  initLayers();
  installMockPlatform();
  resetStudioState();
  // Happy-dom's pointer capture needs an active pointer; stub it out.
  (wrapEl() as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
  (wrapEl() as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
    () => {};
  initShortcuts(() => ({
    applyTransform,
    canvasMode,
    openProject,
    panX,
    panY,
    positionZoomIndicator,
    saveFile,
    setPan,
  }));
});

beforeEach(() => {
  canvasMode = "design";
  panX = 0;
  panY = 0;
  for (const m of [
    setPan,
    applyTransform,
    positionZoomIndicator,
    saveFile,
    openProject,
    openQuickSearch,
    copyNode,
    cutNode,
    pasteNode,
  ]) {
    m.mockClear();
  }
  resetWorkspaceWithTab(freshDoc());
});

afterEach(() => {
  if (isEditing()) {
    stopEditing();
  }
});

function pressDoc(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init });
  document.dispatchEvent(e);
  return e;
}

function wheel(target: EventTarget, init: WheelEventInit = {}) {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // Happy-dom's WheelEvent constructor drops modifier-key init fields; force them.
  for (const k of ["ctrlKey", "metaKey", "shiftKey"] as const) {
    if (init[k]) {
      Object.defineProperty(e, k, { value: true });
    }
  }
  target.dispatchEvent(e);
  return e;
}

// ─── Wheel handler ────────────────────────────────────────────────────────────

describe("wheel handler", () => {
  test("ctrl+wheel zooms toward the cursor", () => {
    const e = wheel(wrapEl(), { clientX: 100, clientY: 80, ctrlKey: true, deltaY: -100 });
    expect(e.defaultPrevented).toBe(true);
    // OldZoom 1, delta = 0.5 → newZoom 1.5
    expect(activeTab.value!.session.ui.zoom).toBeCloseTo(1.5);
    expect(setPan).toHaveBeenCalled();
    expect(applyTransform).toHaveBeenCalled();
  });

  test("ctrl+wheel clamps zoom to max 5", () => {
    activeTab.value!.session.ui.zoom = 4.9;
    wheel(wrapEl(), { ctrlKey: true, deltaY: -10_000 });
    expect(activeTab.value!.session.ui.zoom).toBe(5);
  });

  test("ctrl+wheel clamps zoom to min 0.05", () => {
    activeTab.value!.session.ui.zoom = 0.06;
    wheel(wrapEl(), { ctrlKey: true, deltaY: 10_000 });
    expect(activeTab.value!.session.ui.zoom).toBe(0.05);
  });

  test("plain wheel pans both axes", () => {
    wheel(wrapEl(), { deltaX: 10, deltaY: 20 });
    expect(setPan).toHaveBeenCalledWith(-10, -20);
  });

  test("shift+wheel pans horizontally", () => {
    wheel(wrapEl(), { deltaY: 30, shiftKey: true });
    expect(setPan).toHaveBeenCalledWith(-30, 0);
  });

  test("edit mode without a content-edit-canvas lets native scrolling happen", () => {
    canvasMode = "edit";
    const e = wheel(wrapEl(), { deltaY: 20 });
    expect(e.defaultPrevented).toBe(false);
    expect(setPan).not.toHaveBeenCalled();
  });

  test("edit mode scrolls the content-edit-canvas and prevents default", () => {
    canvasMode = "edit";
    const sc = document.createElement("div");
    sc.className = "content-edit-canvas";
    sc.scrollTop = 0;
    sc.scrollLeft = 0;
    wrapEl().append(sc);
    const e = wheel(wrapEl(), { deltaX: 0, deltaY: 50 });
    expect(sc.scrollTop).toBe(50);
    expect(e.defaultPrevented).toBe(true);
    expect(setPan).not.toHaveBeenCalled();
    sc.remove();
  });

  test("edit mode with no content-edit-canvas does not throw", () => {
    canvasMode = "edit";
    expect(() => wheel(wrapEl(), { deltaY: 50 })).not.toThrow();
  });

  test("manage mode lets the browse table scroll", () => {
    canvasMode = "manage";
    const e = wheel(wrapEl(), { deltaY: 20 });
    expect(e.defaultPrevented).toBe(false);
    expect(setPan).not.toHaveBeenCalled();
  });

  test("ctrl+wheel outside canvas is blocked (browser zoom prevention)", () => {
    const e = wheel(document.body, { ctrlKey: true, deltaY: 10 });
    expect(e.defaultPrevented).toBe(true);
  });

  test("plain wheel outside canvas is not blocked", () => {
    const e = wheel(document.body, { deltaY: 10 });
    expect(e.defaultPrevented).toBe(false);
  });

  test("ctrl+wheel inside canvas is not blocked by the document handler", () => {
    canvasMode = "edit"; // Canvas handler returns early; only the doc blocker could prevent
    const child = document.createElement("div");
    wrapEl().append(child);
    const e = wheel(child, { ctrlKey: true, deltaY: 10 });
    expect(e.defaultPrevented).toBe(false);
    child.remove();
  });
});

// ─── Middle-mouse panning ─────────────────────────────────────────────────────

describe("middle-mouse panning", () => {
  function pointer(type: string, init: PointerEventInit = {}) {
    const e = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
    wrapEl().dispatchEvent(e);
    return e;
  }

  test("middle button drag pans the canvas", () => {
    const down = pointer("pointerdown", { button: 1, clientX: 10, clientY: 10, pointerId: 1 });
    expect(down.defaultPrevented).toBe(true);

    pointer("pointermove", { clientX: 15, clientY: 30, pointerId: 1 });
    expect(setPan).toHaveBeenCalledWith(5, 20);
    expect(applyTransform).toHaveBeenCalled();

    pointer("pointerup", { pointerId: 1 });
    setPan.mockClear();
    pointer("pointermove", { clientX: 99, clientY: 99, pointerId: 1 });
    expect(setPan).not.toHaveBeenCalled();
  });

  test("left button does not pan", () => {
    const down = pointer("pointerdown", { button: 0, pointerId: 2 });
    expect(down.defaultPrevented).toBe(false);
    pointer("pointermove", { clientX: 5, clientY: 5, pointerId: 2 });
    expect(setPan).not.toHaveBeenCalled();
  });

  test("edit mode disables panning", () => {
    canvasMode = "edit";
    const down = pointer("pointerdown", { button: 1, pointerId: 3 });
    expect(down.defaultPrevented).toBe(false);
  });
});

// ─── Resize listener ──────────────────────────────────────────────────────────

test("window resize repositions the zoom indicator", () => {
  window.dispatchEvent(new Event("resize"));
  expect(positionZoomIndicator).toHaveBeenCalled();
});

// ─── Keydown: input/editing guards ────────────────────────────────────────────

describe("keydown guards", () => {
  test("ctrl+s inside an input saves without other shortcuts firing", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const e = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "s",
    });
    input.dispatchEvent(e);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    input.remove();
  });

  test("ctrl+w inside an input is prevented but does not close the tab", () => {
    openTab({ document: { tagName: "div" }, id: "second-tab" });
    const input = document.createElement("input");
    document.body.append(input);
    const e = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "w",
    });
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(workspace.tabOrder.length).toBe(2);
    input.remove();
  });

  test("other keys inside an input are ignored", () => {
    activeTab.value!.session.selection = ["children", 0];
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
    input.remove();
  });

  test("ctrl+s while inline editing stops editing and saves", () => {
    const p = document.createElement("p");
    p.textContent = "edit me";
    document.body.append(p);
    startEditing(p, ["children", 0], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    expect(isEditing()).toBe(true);
    pressDoc("s", { ctrlKey: true });
    expect(isEditing()).toBe(false);
    expect(saveFile).toHaveBeenCalledTimes(1);
    p.remove();
  });

  test("ctrl+w while inline editing is prevented and other keys pass through", () => {
    const p = document.createElement("p");
    document.body.append(p);
    startEditing(p, ["children", 0], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    const e = pressDoc("w", { ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);

    activeTab.value!.session.selection = ["children", 0];
    pressDoc("Escape");
    // Editing guard returns early — selection untouched
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
    stopEditing();
    p.remove();
  });
});

// ─── Keydown: mod shortcuts ───────────────────────────────────────────────────

describe("mod shortcuts", () => {
  test("ctrl+w with a single tab does nothing", () => {
    pressDoc("w", { ctrlKey: true });
    expect(workspace.tabOrder.length).toBe(1);
  });

  test("ctrl+w closes a clean tab when several are open", () => {
    openTab({ document: { tagName: "div" }, id: "second-tab" });
    expect(workspace.activeTabId).toBe("second-tab");
    pressDoc("w", { ctrlKey: true });
    expect(workspace.tabOrder).toEqual(["test-tab"]);
  });

  test("ctrl+w on a dirty tab shows a confirm dialog and closes on confirm", async () => {
    const tab = openTab({
      document: { tagName: "div" },
      documentPath: "/project/dirty.json",
      id: "dirty-tab",
    });
    tab.doc.dirty = true;
    pressDoc("w", { ctrlKey: true });
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("headline")).toBe("Unsaved Changes");
    dialog!.dispatchEvent(new Event("confirm"));
    await flush();
    expect(workspace.tabOrder).toEqual(["test-tab"]);
  });

  test("ctrl+w on a dirty tab keeps it open on cancel", async () => {
    const tab = openTab({ document: { tagName: "div" }, id: "dirty-tab" });
    tab.doc.dirty = true;
    pressDoc("w", { ctrlKey: true });
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper");
    dialog!.dispatchEvent(new Event("cancel"));
    await flush();
    expect(workspace.tabOrder).toEqual(["test-tab", "dirty-tab"]);
  });

  test("ctrl+o opens a project", () => {
    pressDoc("o", { ctrlKey: true });
    expect(openProject).toHaveBeenCalledTimes(1);
  });

  test("ctrl+p opens quick search", () => {
    pressDoc("p", { ctrlKey: true });
    expect(openQuickSearch).toHaveBeenCalledTimes(1);
  });

  test("meta+s saves the file", () => {
    pressDoc("s", { metaKey: true });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  test("ctrl+d duplicates the selected node, ctrl+z undoes, ctrl+shift+z redoes", () => {
    const tab = activeTab.value!;
    tab.session.selection = ["children", 0];
    pressDoc("d", { ctrlKey: true });
    expect((tab.doc.document.children as unknown[]).length).toBe(4);

    pressDoc("z", { ctrlKey: true });
    expect((tab.doc.document.children as unknown[]).length).toBe(3);

    pressDoc("z", { ctrlKey: true, shiftKey: true });
    expect((tab.doc.document.children as unknown[]).length).toBe(4);
  });

  test("ctrl+d without selection does nothing", () => {
    pressDoc("d", { ctrlKey: true });
    expect((activeTab.value!.doc.document.children as unknown[]).length).toBe(3);
  });

  test("ctrl+c / ctrl+x / ctrl+v invoke clipboard actions", () => {
    pressDoc("c", { ctrlKey: true });
    expect(copyNode).toHaveBeenCalledTimes(1);
    pressDoc("x", { ctrlKey: true });
    expect(cutNode).toHaveBeenCalledTimes(1);
    pressDoc("v", { ctrlKey: true });
    expect(pasteNode).toHaveBeenCalledTimes(1);
  });

  test("ctrl+0 resets zoom and pan", () => {
    activeTab.value!.session.ui.zoom = 2.5;
    pressDoc("0", { ctrlKey: true });
    expect(activeTab.value!.session.ui.zoom).toBe(1);
    expect(setPan).toHaveBeenCalledWith(16, 16);
    expect(applyTransform).toHaveBeenCalled();
  });

  test("ctrl+= zooms in, ctrl+- zooms out", () => {
    pressDoc("=", { ctrlKey: true });
    expect(activeTab.value!.session.ui.zoom).toBeCloseTo(1.2);
    pressDoc("-", { ctrlKey: true });
    expect(activeTab.value!.session.ui.zoom).toBeCloseTo(1);
  });

  test("zoom shortcuts are inert in edit mode", () => {
    canvasMode = "edit";
    activeTab.value!.session.ui.zoom = 2;
    pressDoc("0", { ctrlKey: true });
    pressDoc("=", { ctrlKey: true });
    pressDoc("-", { ctrlKey: true });
    expect(activeTab.value!.session.ui.zoom).toBe(2);
    expect(setPan).not.toHaveBeenCalled();
  });

  test("unknown mod key falls through harmlessly", () => {
    pressDoc("q", { ctrlKey: true });
    expect(saveFile).not.toHaveBeenCalled();
  });
});

// ─── Keydown: plain shortcuts ─────────────────────────────────────────────────

describe("plain shortcuts", () => {
  test("Delete removes the selected node", () => {
    const tab = activeTab.value!;
    tab.session.selection = ["children", 0];
    pressDoc("Delete");
    const children = tab.doc.document.children as { textContent?: string }[];
    expect(children.length).toBe(2);
    expect(children[0]!.textContent).toBeUndefined();
  });

  test("Backspace with root selection does nothing", () => {
    const tab = activeTab.value!;
    tab.session.selection = [];
    pressDoc("Backspace");
    expect((tab.doc.document.children as unknown[]).length).toBe(3);
  });

  test("Escape clears the selection", () => {
    activeTab.value!.session.selection = ["children", 0];
    pressDoc("Escape");
    expect(activeTab.value!.session.selection).toBeNull();
  });

  test("Enter inserts a paragraph after the selection and selects it", () => {
    const tab = activeTab.value!;
    tab.session.selection = ["children", 0];
    pressDoc("Enter");
    const children = tab.doc.document.children as { tagName?: string; textContent?: string }[];
    expect(children.length).toBe(4);
    expect(children[1]).toEqual({ tagName: "p", textContent: "" });
    // The new node is selected; the iframe canvas re-enters inline edit for it via its own posted
    // EnterEdit flow (no parent-side enterEditOnPath callback anymore).
    expect(tab.session.selection).toEqual(["children", 1]);
  });

  test("ArrowDown moves selection to the next sibling", () => {
    activeTab.value!.session.selection = ["children", 0];
    pressDoc("ArrowDown");
    expect(activeTab.value!.session.selection).toEqual(["children", 1]);
  });

  test("ArrowUp moves selection to the previous sibling", () => {
    activeTab.value!.session.selection = ["children", 1];
    pressDoc("ArrowUp");
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
  });

  test("ArrowUp at the first sibling stays put", () => {
    activeTab.value!.session.selection = ["children", 0];
    pressDoc("ArrowUp");
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
  });

  test("ArrowDown without selection selects the root", () => {
    activeTab.value!.session.selection = null;
    pressDoc("ArrowDown");
    expect(activeTab.value!.session.selection as unknown).toEqual([]);
  });

  test("ArrowDown with root selection is a no-op", () => {
    activeTab.value!.session.selection = [];
    pressDoc("ArrowDown");
    expect(activeTab.value!.session.selection).toEqual([]);
  });

  test("ArrowLeft selects the parent element", () => {
    activeTab.value!.session.selection = ["children", 1, "children", 0];
    pressDoc("ArrowLeft");
    expect(activeTab.value!.session.selection).toEqual(["children", 1]);
  });

  test("ArrowRight descends into the first child", () => {
    activeTab.value!.session.selection = ["children", 1];
    pressDoc("ArrowRight");
    expect(activeTab.value!.session.selection).toEqual(["children", 1, "children", 0]);
  });

  test("ArrowRight on a childless node stays put", () => {
    activeTab.value!.session.selection = ["children", 0];
    pressDoc("ArrowRight");
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
  });

  test("unhandled plain keys fall through", () => {
    activeTab.value!.session.selection = ["children", 0];
    pressDoc("a");
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
  });
});
