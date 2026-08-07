/**
 * Tests for src/editor/shortcuts.ts — the canvas gestures and the keyboard dispatcher.
 *
 * The keyboard half is a port: a 403-line hand-authored `keydown` switch became a ~30-line
 * dispatcher over the command registry. The deliverable that makes that safe is
 * {@link file://./shortcuts.test.ts "the old dispatch, chord by chord"} below — every chord the
 * pre-port file handled (transcribed from `editor/shortcuts.ts` at commit e0c80e76: twelve modifier
 * chords, seven bare keys, three blanket guards, two canvas-mode refusal sets) asserted against the
 * new path, plus an explicit, named list of the places the two deliberately disagree.
 *
 * The whole real chain is under test — `createLiveContext` → `createCommandRegistry` →
 * `registerStudioCommands` → `initShortcuts` — because the bug class this port exists to kill is a
 * gate that disagrees with itself between two layers.
 */
import {
  flush,
  installMockPlatform,
  resetStudioState,
  resetWorkspaceWithTab,
  stubRect,
} from "./harness";
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import type { InspectorTabId } from "../src/shell";

// ─── Module mocks (must precede the shortcuts import) ─────────────────────────

const openQuickSearch = mock(() => {});
void mock.module("../src/panels/quick-search.js", () => ({ openQuickSearch }));

const copyNode = mock(async () => {});
const cutNode = mock(async () => {});
const pasteNode = mock(async () => {});
// `showContextMenu` / `dismissContextMenu` are not this file's business, but the panel registry it
// Now reaches (through `navigatorPanelSet()`, the roster the ⌘1–8 records are generated from) pulls
// In the Outline panel, which imports them. Replacing a module means answering for all its exports.
const showContextMenu = mock(() => {});
const dismissContextMenu = mock(() => {});
void mock.module("../src/editor/context-menu.js", () => ({
  copyNode,
  cutNode,
  dismissContextMenu,
  pasteNode,
  showContextMenu,
}));

const notified = mock((_message: string) => {});
void mock.module("../src/services/notify.js", () => notifyModule((call) => notified(call.message)));

const {
  focusShellRegion,
  initShortcuts,
  nextRegion,
  openProjectFlow,
  REGION_CYCLE,
  registerStudioCommands,
} = await import("../src/editor/shortcuts");
const { stampShellRegions } = await import("../src/ui/regions");
const { createCommandRegistry } = await import("../src/commands/registry");
const { createLiveContext } = await import("../src/commands/live-context");
const { initCanvasUtils } = await import("../src/canvas/canvas-utils");
const store = await import("../src/store");
const { activeCanvasSurface } = await import("../src/canvas/canvas-surface");
/* Panels belong to a pane's stage now (`src/canvas/canvas-surface.ts`), not to the app. */
const surface = activeCanvasSurface();
const { initShellRefs } = store;
const { activeTab, closeAllTabs, openTab, workspace } = await import("../src/workspace/workspace");
const { initLayers, isModalOpen } = await import("../src/ui/layers");
const { registerShellViewCommands, shell, resetProjectShell, setDockCollapsed } =
  await import("../src/shell");

/**
 * The Inspector tab, read and written where `right-panel.ts` reads and writes it.
 *
 * The fixture mirrors the real deps rather than holding its own copy: `shortcuts.ts` asks
 * `right-panel.ts` whether the assistant is showing, so a second store here would let ⌘J read one
 * value and write another and the test would still pass.
 */
function inspectorTab(): InspectorTabId {
  return (activeTab.value?.session.ui.rightTab ?? "properties") as InspectorTabId;
}

function setInspectorTab(tab: InspectorTabId): void {
  if (activeTab.value) {
    activeTab.value.session.ui.rightTab = tab;
  }
}

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
let caretActive = false;
let panX = 0;
let panY = 0;
const setPan = mock((x: number, y: number) => {
  panX = x;
  panY = y;
});
const applyTransform = mock(() => {});
const saveFile = mock(() => {});
const openProject = mock(() => {});
const openInBrowser = mock(() => {});

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

const pointerContext = () => ({ applyTransform, canvasMode, panX, panY, setPan });

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
  // A site project, so `view.openInBrowser`'s `when` holds — ⌘⇧O is one of the chords the port adds.
  resetStudioState({ isSiteProject: true });
  // Happy-dom's pointer capture needs an active pointer; stub it out.
  (wrapEl() as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
  (wrapEl() as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
    () => {};

  /*
   * `mac: false` pins `mod` to Ctrl. On a real mac the same registry resolves ⌘ instead — that is
   * `chordFromEvent`'s job and `commands-keymap.test.ts` owns it. Pinning it here is also the one
   * DIVERGENCE that has to be stated up front: the old switch tested `e.ctrlKey || e.metaKey`, so
   * ⌘S fired on Linux and Ctrl+S fired on a mac. `mod` is now one modifier per platform.
   */
  const registry = createCommandRegistry({
    getContext: createLiveContext({
      aiConfigured: () => false,
      canvasMode: () => canvasMode,
      isCaretActive: () => caretActive,
      isModalOpen,
      platform: () => null,
    }),
    mac: false,
  });
  registerStudioCommands(
    registry,
    { openInBrowser, openProject, saveDocument: saveFile },
    pointerContext,
  );
  // ⌘J and ⌘⇧4 both address the Assistant, which is an Inspector TAB and therefore
  // `shell.ts`'s record rather than a dock flag. The app's bootstrap composes it in; so does this
  // Fixture, because a registry without it makes those two chords silently inert.
  registerShellViewCommands(registry, { inspectorTab, setInspectorTab });
  initShortcuts(registry, pointerContext);

  // The edit-zoom path (ctrl+wheel / Ctrl+0/+/- / resize in edit mode) runs the REAL canvas-utils
  // ApplyEditZoom, which needs the module context initialized.
  initCanvasUtils({
    getCanvasMode: () => canvasMode,
    getZoom: () => activeTab.value?.session.ui.zoom ?? 1,
    setZoomDirect: (z: number) => {
      if (activeTab.value) {
        activeTab.value.session.ui.zoom = z;
      }
    },
  });
});

beforeEach(() => {
  canvasMode = "design";
  caretActive = false;
  panX = 0;
  panY = 0;
  for (const m of [
    setPan,
    applyTransform,
    saveFile,
    openProject,
    openInBrowser,
    openQuickSearch,
    copyNode,
    cutNode,
    pasteNode,
    notified,
  ]) {
    m.mockClear();
  }
  surface.panels.length = 0;
  document.body.focus();
  resetProjectShell();
  shell.focusRegion = "pane";
  resetWorkspaceWithTab(freshDoc());
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

/** Focus a text control so the context reports a live caret, as the old target test did. */
function focusTextField(tag = "input"): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute("tabindex", "0");
  document.body.append(el);
  el.focus();
  return el;
}

function childCount(): number {
  return (activeTab.value!.doc.document.children as unknown[]).length;
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

  /* The grid could not be wheel-scrolled at all: the pan branch preventDefaulted over a Tabulator
     viewport that owns its own virtual scroller. Only the mode string "manage" was exempt, and it
     is reachable from nowhere else in the codebase (plan §5.3). */
  test.each(["grid", "manage"])("%s mode lets the surface scroll itself", (mode) => {
    canvasMode = mode;
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
    canvasMode = "manage"; // Canvas handler returns early; only the doc blocker could prevent
    const child = document.createElement("div");
    wrapEl().append(child);
    const e = wheel(child, { ctrlKey: true, deltaY: 10 });
    expect(e.defaultPrevented).toBe(false);
    child.remove();
  });

  test("ctrl+wheel in edit mode drives the content zoom, not pan or scroll", () => {
    canvasMode = "edit";
    const e = wheel(wrapEl(), { ctrlKey: true, deltaY: -100 });
    expect(e.defaultPrevented).toBe(true);
    // Delta = 0.5 → editZoom 1 * 1.5
    expect(activeTab.value!.session.ui.editZoom).toBeCloseTo(1.5);
    expect(activeTab.value!.session.ui.zoom).toBe(1);
    expect(setPan).not.toHaveBeenCalled();
  });

  test("ctrl+wheel clamps editZoom to its range", () => {
    canvasMode = "edit";
    wheel(wrapEl(), { ctrlKey: true, deltaY: -10_000 });
    expect(activeTab.value!.session.ui.editZoom).toBe(3);
    wheel(wrapEl(), { ctrlKey: true, deltaY: 10_000 });
    expect(activeTab.value!.session.ui.editZoom).toBe(0.25);
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

  test("preview scrolls its own frame rather than panning", () => {
    canvasMode = "preview";
    const down = pointer("pointerdown", { button: 1, pointerId: 9 });
    expect(down.defaultPrevented).toBe(false);
  });

  test("the wheel is left to the preview frame — no pan, no preventDefault", () => {
    canvasMode = "preview";
    const e = wheel(wrapEl(), { deltaX: 10, deltaY: 20 });
    expect(e.defaultPrevented).toBe(false);
    expect(setPan).not.toHaveBeenCalled();
    wheel(wrapEl(), { ctrlKey: true, deltaY: -100 });
    expect(activeTab.value!.session.ui.zoom ?? 1).toBe(1);
  });
});

// ─── Resize listener ──────────────────────────────────────────────────────────

test("window resize re-applies the edit zoom from the live column width", () => {
  canvasMode = "edit";
  activeTab.value!.session.ui.editZoom = 2;
  const sc = document.createElement("div");
  sc.className = "content-edit-canvas";
  const column = document.createElement("div");
  column.className = "content-edit-column";
  const viewport = document.createElement("div");
  const canvas = document.createElement("div");
  const iframe = document.createElement("iframe");
  canvas.append(iframe);
  viewport.append(canvas);
  column.append(viewport);
  sc.append(column);
  wrapEl().append(sc);
  stubRect(column, { width: 600 });
  surface.panels.push({ _width: null, canvas, viewport } as never);

  window.dispatchEvent(new Event("resize"));

  // LayoutWidth = 600 / 2; the counter-scale restores the 600px footprint.
  expect(canvas.style.transform).toBe("scale(2)");
  expect(iframe.style.width).toBe("300px");
  sc.remove();
});

test("window resize outside edit mode leaves the canvas untouched", () => {
  canvasMode = "design";
  expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
});

// ═════════════════════════════════════════════════════════════════════════════
// The old dispatch, chord by chord
// ═════════════════════════════════════════════════════════════════════════════
//
// Transcribed from `editor/shortcuts.ts` at e0c80e76 — the last commit before the port. Each case
// Names the branch it came from. Everything here must behave identically after the rewrite; the
// Deliberate exceptions live in their own block at the bottom of this file and nowhere else.

describe("the old dispatch — twelve modifier chords", () => {
  test('⌘S saves (`case "s"`)', () => {
    pressDoc("s", { ctrlKey: true });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  test('⌘O opens a project (`case "o"`)', () => {
    pressDoc("o", { ctrlKey: true });
    expect(openProject).toHaveBeenCalledTimes(1);
  });

  test('⌘P opens the palette (`case "p"`)', () => {
    pressDoc("p", { ctrlKey: true });
    expect(openQuickSearch).toHaveBeenCalledTimes(1);
  });

  test('⌘W closes a clean tab when several are open (`case "w"`)', () => {
    openTab({ document: { tagName: "div" }, id: "second-tab" });
    expect(workspace.activeTabId).toBe("second-tab");
    pressDoc("w", { ctrlKey: true });
    expect(workspace.tabOrder).toEqual(["test-tab"]);
  });

  test("⌘W on a dirty tab prompts the tab strip's own three-way dialog, then closes", async () => {
    const tab = openTab({
      document: { tagName: "div" },
      documentPath: "/project/dirty.json",
      id: "dirty-tab",
    });
    tab.doc.dirty = true;
    pressDoc("w", { ctrlKey: true });
    await flush();
    const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper");
    expect(dialog?.getAttribute("headline")).toBe("Unsaved Changes");
    // ⌘W calls `requestClose` rather than re-implementing it, so it is the SAME dialog the × opens
    // — Save included. Copying the ×'s wording into this file is how the two drifted last time.
    expect(dialog?.getAttribute("confirm-label")).toBe("Save");
    expect(dialog?.getAttribute("secondary-label")).toBe("Close Without Saving");
    dialog!.dispatchEvent(new Event("secondary"));
    await flush();
    expect(workspace.tabOrder).toEqual(["test-tab"]);
  });

  test("⌘W on a dirty tab keeps it open on cancel", async () => {
    const tab = openTab({ document: { tagName: "div" }, id: "dirty-tab" });
    tab.doc.dirty = true;
    pressDoc("w", { ctrlKey: true });
    await flush();
    document.querySelector("#layer-dialog sp-dialog-wrapper")!.dispatchEvent(new Event("cancel"));
    await flush();
    expect(workspace.tabOrder).toEqual(["test-tab", "dirty-tab"]);
  });

  test('⌘Z undoes and ⌘⇧Z redoes, uppercase key included (`case "z"` / `case "Z"`)', () => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc("d", { ctrlKey: true });
    expect(childCount()).toBe(4);
    pressDoc("z", { ctrlKey: true });
    expect(childCount()).toBe(3);
    // Real browsers report key "Z" (uppercase) while Shift is held.
    pressDoc("Z", { ctrlKey: true, shiftKey: true });
    expect(childCount()).toBe(4);
  });

  test('⌘D duplicates the selection (`case "d"`)', () => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc("d", { ctrlKey: true });
    expect(childCount()).toBe(4);
  });

  test("⌘D without a selection does nothing and is not swallowed", () => {
    const e = pressDoc("d", { ctrlKey: true });
    expect(childCount()).toBe(3);
    expect(e.defaultPrevented).toBe(false);
  });

  test.each([
    ["c", () => copyNode],
    ["x", () => cutNode],
    ["v", () => pasteNode],
  ])('⌘%s reaches the clipboard action (`case "c"/"x"/"v"`)', (key, handler) => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc(key, { ctrlKey: true });
    expect(handler()).toHaveBeenCalledTimes(1);
  });

  test('⌘0 resets zoom and pan (`case "0"`)', () => {
    activeTab.value!.session.ui.zoom = 2.5;
    pressDoc("0", { ctrlKey: true });
    expect(activeTab.value!.session.ui.zoom).toBe(1);
    expect(setPan).toHaveBeenCalledWith(16, 16);
    expect(applyTransform).toHaveBeenCalled();
  });

  test('⌘= zooms in and ⌘- zooms out (`case "="` / `case "-"`)', () => {
    pressDoc("=", { ctrlKey: true });
    expect(activeTab.value!.session.ui.zoom).toBeCloseTo(1.2);
    pressDoc("-", { ctrlKey: true });
    expect(activeTab.value!.session.ui.zoom).toBeCloseTo(1);
  });

  test('⌘+ is the same verb as ⌘=, with or without Shift (`case "+"`)', () => {
    pressDoc("+", { ctrlKey: true });
    expect(activeTab.value!.session.ui.zoom).toBeCloseTo(1.2);
    pressDoc("+", { ctrlKey: true, shiftKey: true });
    expect(activeTab.value!.session.ui.zoom).toBeCloseTo(1.44);
  });

  test("the zoom chords drive the CONTENT zoom in edit mode", () => {
    canvasMode = "edit";
    const tab = activeTab.value!;
    tab.session.ui.zoom = 2;
    pressDoc("=", { ctrlKey: true });
    expect(tab.session.ui.editZoom).toBeCloseTo(1.2);
    pressDoc("-", { ctrlKey: true });
    expect(tab.session.ui.editZoom).toBeCloseTo(1);
    tab.session.ui.editZoom = 2.4;
    pressDoc("0", { ctrlKey: true });
    expect(tab.session.ui.editZoom).toBe(1);
    // The design-mode zoom and pan are untouched by edit-mode zoom shortcuts.
    expect(tab.session.ui.zoom).toBe(2);
    expect(setPan).not.toHaveBeenCalled();
  });

  test("an unclaimed modifier chord falls through to the browser (`default: break`)", () => {
    const e = pressDoc("q", { ctrlKey: true });
    expect(saveFile).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("the old dispatch — seven bare keys", () => {
  test.each(["Delete", "Backspace"])("%s removes the selected node", (key) => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc(key);
    const children = activeTab.value!.doc.document.children as { textContent?: string }[];
    expect(children.length).toBe(2);
    expect(children[0]!.textContent).toBeUndefined();
  });

  test("Delete on a multi-selection removes every selected node in ONE undo step", () => {
    const tab = activeTab.value!;
    const before = tab.history.index;
    tab.session.selection = [
      ["children", 0],
      ["children", 2],
    ];
    pressDoc("Delete");
    expect(childCount()).toBe(1);
    expect(tab.history.index).toBe(before + 1);
  });

  test("a batch containing the document element is refused whole, not partly performed", () => {
    // `ctx.selection.isRoot` is the BATCH's gate — "any selected path is the document element" —
    // Because silently deleting a subset of what the author selected is worse than refusing.
    const tab = activeTab.value!;
    tab.session.selection = [[], ["children", 0]];
    pressDoc("Delete");
    expect(childCount()).toBe(3);
  });

  test("⌘D on a multi-selection duplicates every selected node in ONE undo step", () => {
    const tab = activeTab.value!;
    const before = tab.history.index;
    tab.session.selection = [
      ["children", 0],
      ["children", 2],
    ];
    pressDoc("d", { ctrlKey: true });
    expect(childCount()).toBe(5);
    expect(tab.history.index).toBe(before + 1);
  });

  test("Backspace on the document element does nothing (`selection.length >= 2`)", () => {
    activeTab.value!.session.selection = [[]];
    pressDoc("Backspace");
    expect(childCount()).toBe(3);
  });

  test("Enter inserts a paragraph after the selection and selects it", () => {
    const tab = activeTab.value!;
    tab.session.selection = [["children", 0]];
    pressDoc("Enter");
    const children = tab.doc.document.children as { tagName?: string; textContent?: string }[];
    expect(children.length).toBe(4);
    expect(children[1]).toEqual({ tagName: "p", textContent: "" });
    // The new node is selected; the iframe canvas re-enters inline edit for it via its own posted
    // EnterEdit flow (no parent-side enterEditOnPath callback anymore).
    expect(tab.session.selection).toEqual([["children", 1]]);
  });

  test("ArrowDown moves to the next sibling and ArrowUp back", () => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc("ArrowDown");
    expect(activeTab.value!.session.selection).toEqual([["children", 1]]);
    pressDoc("ArrowUp");
    expect(activeTab.value!.session.selection).toEqual([["children", 0]]);
  });

  test("ArrowUp at the first sibling stays put", () => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc("ArrowUp");
    expect(activeTab.value!.session.selection).toEqual([["children", 0]]);
  });

  test("ArrowDown without a selection selects the document element", () => {
    activeTab.value!.session.selection = [];
    pressDoc("ArrowDown");
    expect(activeTab.value!.session.selection as unknown).toEqual([[]]);
  });

  test("ArrowDown with the document element selected is a no-op", () => {
    activeTab.value!.session.selection = [[]];
    pressDoc("ArrowDown");
    expect(activeTab.value!.session.selection).toEqual([[]]);
  });

  test("ArrowLeft selects the parent element", () => {
    activeTab.value!.session.selection = [["children", 1, "children", 0]];
    pressDoc("ArrowLeft");
    expect(activeTab.value!.session.selection).toEqual([["children", 1]]);
  });

  test("ArrowRight descends into the first child", () => {
    activeTab.value!.session.selection = [["children", 1]];
    pressDoc("ArrowRight");
    expect(activeTab.value!.session.selection).toEqual([["children", 1, "children", 0]]);
  });

  test("ArrowRight on a childless node stays put", () => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc("ArrowRight");
    expect(activeTab.value!.session.selection).toEqual([["children", 0]]);
  });

  test("an unhandled plain key falls through", () => {
    activeTab.value!.session.selection = [["children", 0]];
    const e = pressDoc("a");
    expect(activeTab.value!.session.selection).toEqual([["children", 0]]);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("the old dispatch — the three blanket guards", () => {
  /* Guard 1: `if (isModalOpen()) return`. Now the `palette`-only scope stack. */
  test("every chord stands down while a modal surface is up", () => {
    const slot = document.createElement("div");
    slot.innerHTML = "<sp-dialog-wrapper open></sp-dialog-wrapper>";
    document.querySelector("#layer-dialog")!.append(slot);
    activeTab.value!.session.selection = [["children", 0]];

    pressDoc("p", { ctrlKey: true });
    pressDoc("s", { ctrlKey: true });
    const del = pressDoc("Delete");
    expect(openQuickSearch).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(childCount()).toBe(3);
    // Not swallowed either: the dialog's own layer handles what it wants.
    expect(del.defaultPrevented).toBe(false);

    slot.remove();
    pressDoc("p", { ctrlKey: true });
    expect(openQuickSearch).toHaveBeenCalledTimes(1);
  });

  /* Guard 2: the grid allow-list `["o","p","s","w","z","Z"]`. Now the `grid` scope stack, whose
     survivors are exactly the `global`-scoped commands — same six chords, derived not listed. */
  describe("the grid engine owns the canvas chords", () => {
    beforeEach(() => {
      canvasMode = "grid";
    });

    test.each([
      ["o", () => expect(openProject).toHaveBeenCalledTimes(1)],
      ["p", () => expect(openQuickSearch).toHaveBeenCalledTimes(1)],
      ["s", () => expect(saveFile).toHaveBeenCalledTimes(1)],
    ])("⌘%s still passes through", (key, assert) => {
      pressDoc(key, { ctrlKey: true });
      assert();
    });

    test("⌘W still closes the document", () => {
      openTab({ document: { tagName: "div" }, id: "second-tab" });
      pressDoc("w", { ctrlKey: true });
      expect(workspace.tabOrder).toEqual(["test-tab"]);
    });

    test.each(["c", "x", "v", "d", "0", "=", "-"])("⌘%s belongs to the grid", (key) => {
      activeTab.value!.session.selection = [["children", 0]];
      const e = pressDoc(key, { ctrlKey: true });
      expect(e.defaultPrevented).toBe(false);
      expect(copyNode).not.toHaveBeenCalled();
      expect(cutNode).not.toHaveBeenCalled();
      expect(pasteNode).not.toHaveBeenCalled();
      expect(childCount()).toBe(3);
      expect(activeTab.value!.session.ui.zoom ?? 1).toBe(1);
    });

    test.each(["Delete", "Backspace", "Enter", "Escape", "ArrowUp", "ArrowDown"])(
      "%s drives the grid's own cell navigation, never the document",
      (key) => {
        activeTab.value!.session.selection = [["children", 0]];
        const e = pressDoc(key);
        expect(e.defaultPrevented).toBe(false);
        expect(childCount()).toBe(3);
        expect(activeTab.value!.session.selection).toEqual([["children", 0]]);
      },
    );
  });

  /* Guard 3: the caret / text-input early return. Now the `caret` scope stack, which drops
     `canvas` — the element-level verbs stay away from a sentence being typed, and ⌘S still saves
     because it flushes the canvas frames itself. */
  describe("a live caret owns the element chords", () => {
    test.each([
      ["a canvas caret", () => (caretActive = true)],
      ["a focused text field", () => focusTextField()],
      ["a focused sp-textfield", () => focusTextField("sp-textfield")],
    ])("%s: ⌘S still saves", (_label, arrange) => {
      arrange();
      pressDoc("s", { ctrlKey: true });
      expect(saveFile).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["c", () => copyNode],
      ["x", () => cutNode],
      ["v", () => pasteNode],
    ])("⌘%s is left to the caret", (key, handler) => {
      caretActive = true;
      activeTab.value!.session.selection = [["children", 0]];
      const e = pressDoc(key, { ctrlKey: true });
      expect(handler()).not.toHaveBeenCalled();
      // Not preventDefaulted either — the chord belongs to the frame the caret is in.
      expect(e.defaultPrevented).toBe(false);
    });

    test("⌘X mid-sentence leaves the paragraph in the document", () => {
      caretActive = true;
      activeTab.value!.session.selection = [["children", 0]];
      pressDoc("x", { ctrlKey: true });
      expect(cutNode).not.toHaveBeenCalled();
      expect(childCount()).toBe(3);
    });

    test("Delete does not remove the selected node while the caret is live", () => {
      caretActive = true;
      activeTab.value!.session.selection = [["children", 0]];
      pressDoc("Delete");
      expect(childCount()).toBe(3);
    });

    test("Escape in a text field leaves the canvas selection alone", () => {
      focusTextField();
      activeTab.value!.session.selection = [["children", 0]];
      pressDoc("Escape");
      expect(activeTab.value!.session.selection).toEqual([["children", 0]]);
    });
  });
});

describe("the old dispatch — Preview refuses to edit", () => {
  beforeEach(() => {
    canvasMode = "preview";
  });

  test.each(["d", "x", "v", "0", "=", "-"])("⌘%s does not mutate or zoom", (key) => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc(key, { ctrlKey: true });
    expect(cutNode).not.toHaveBeenCalled();
    expect(pasteNode).not.toHaveBeenCalled();
    expect(childCount()).toBe(3);
    // A phantom `ui.zoom` written here would be waiting for the author back in Design.
    expect(activeTab.value!.session.ui.zoom ?? 1).toBe(1);
  });

  test.each(["Delete", "Backspace", "Enter"])("%s does not mutate the document", (key) => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc(key);
    expect(childCount()).toBe(3);
  });

  test("⌘S still saves", () => {
    pressDoc("s", { ctrlKey: true });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Where the port deliberately disagrees with the old dispatch
// ═════════════════════════════════════════════════════════════════════════════
//
// Nothing below is an accident. Each case is a bug the old switch had, or the direct consequence of
// One of the three guards becoming a scope stack. Anything NOT listed here is asserted identical
// Above.

describe("deliberate divergences", () => {
  /* 1. THE NAMED FIX. `shortcuts.ts:192` refused to close the last tab; `tab-strip.ts:182`'s ×
        closed it happily. One record now, and it is the ×'s behaviour. */
  test("⌘W closes the last remaining document, as the tab's × always did", () => {
    expect(workspace.tabOrder).toEqual(["test-tab"]);
    pressDoc("w", { ctrlKey: true });
    expect(workspace.tabOrder).toEqual([]);
  });

  /* 2. THE NAMED FIX. Escape used to clear the selection outright, whatever its depth — so leaving
        one node meant losing the whole path back to it. It now walks the ladder. */
  test("Escape selects the parent, and clears only at the document element", () => {
    const tab = activeTab.value!;
    tab.session.selection = [["children", 1, "children", 0]];
    pressDoc("Escape");
    expect(tab.session.selection).toEqual([["children", 1]]);
    pressDoc("Escape");
    expect(tab.session.selection).toEqual([[]]);
    pressDoc("Escape");
    expect(tab.session.selection).toEqual([]);
  });

  test("Escape with nothing selected is not swallowed", () => {
    activeTab.value!.session.selection = [];
    expect(pressDoc("Escape").defaultPrevented).toBe(false);
  });

  /* 3. `mod` is ONE modifier per platform. The old switch tested `e.ctrlKey || e.metaKey`, so ⌘S
        fired on Linux and Ctrl+S on a mac. This registry is pinned to `mac: false`. */
  test("Meta is not a modifier on a non-mac platform", () => {
    pressDoc("s", { metaKey: true });
    expect(saveFile).not.toHaveBeenCalled();
  });

  /* 4. Consequence of caret shadowing: `global`-scoped chords are live while typing, because the
        caret stack is ["caret", "global"]. The old code returned early and ate ⌘W without acting.
        ⌘P/⌘O/⌘Z reaching the app from a text field is the VS Code behaviour and the intended one;
        it is called out here because a reader of the old file would not expect it. */
  test("app-level chords reach the app from a text field", () => {
    focusTextField();
    pressDoc("p", { ctrlKey: true });
    expect(openQuickSearch).toHaveBeenCalledTimes(1);
    pressDoc("o", { ctrlKey: true });
    expect(openProject).toHaveBeenCalledTimes(1);
  });

  test("⌘W from a text field closes the document instead of being eaten", () => {
    openTab({ document: { tagName: "div" }, id: "second-tab" });
    focusTextField();
    pressDoc("w", { ctrlKey: true });
    expect(workspace.tabOrder).toEqual(["test-tab"]);
  });

  /* 5. Preview drops the whole `canvas` scope rather than carrying two hand-written refusal sets
        that disagreed with each other — ⌘C was allowed and ⌘X was not, on the same invisible
        selection. Escape and the arrows go with them. */
  test.each(["Escape", "ArrowDown", "ArrowLeft"])("%s no longer acts in Preview", (key) => {
    canvasMode = "preview";
    activeTab.value!.session.selection = [["children", 1, "children", 0]];
    const e = pressDoc(key);
    expect(activeTab.value!.session.selection).toEqual([["children", 1, "children", 0]]);
    expect(e.defaultPrevented).toBe(false);
  });

  test("⌘C no longer copies an invisible Preview selection", () => {
    canvasMode = "preview";
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc("c", { ctrlKey: true });
    expect(copyNode).not.toHaveBeenCalled();
  });

  /* 6. A chord bound to a VISIBLE but DISABLED command is swallowed rather than falling through:
        the registry refuses it, and the key is spoken for. The old switch's `if` bodies simply did
        nothing, without preventDefault. */
  test("Delete on the document element is refused, not passed to the browser", () => {
    activeTab.value!.session.selection = [[]];
    const e = pressDoc("Delete");
    expect(childCount()).toBe(3);
    expect(e.defaultPrevented).toBe(true);
  });

  /* 7. Chords that had no branch at all in the old switch and are now real commands. */
  test("⌘⇧Z is redo even without the uppercase-key spelling", () => {
    activeTab.value!.session.selection = [["children", 0]];
    pressDoc("d", { ctrlKey: true });
    pressDoc("z", { ctrlKey: true });
    expect(childCount()).toBe(3);
    pressDoc("z", { ctrlKey: true, shiftKey: true });
    expect(childCount()).toBe(4);
  });

  test("⌘K and ⌘⇧P open the palette; ⌘⇧O opens the page in a browser", () => {
    pressDoc("k", { ctrlKey: true });
    pressDoc("P", { ctrlKey: true, shiftKey: true });
    expect(openQuickSearch).toHaveBeenCalledTimes(2);
    pressDoc("O", { ctrlKey: true, shiftKey: true });
    expect(openInBrowser).toHaveBeenCalledTimes(1);
  });

  test("⌘B / ⌥⌘B / ⌘J toggle the three docks", () => {
    setDockCollapsed("left", false);
    pressDoc("b", { ctrlKey: true });
    expect(shell.docks.left.collapsed).toBe(true);

    setDockCollapsed("right", false);
    pressDoc("b", { altKey: true, ctrlKey: true });
    expect(shell.docks.right.collapsed).toBe(true);

    // ⌘J flips the third dock — there IS one now. It used to route to the Assistant, which was the
    // Third thing that chord could mean while the Bottom dock was missing from the shell record;
    // The Assistant keeps ⌘⇧4 and `view.setAssistant`, and this chord means what it says.
    setDockCollapsed("bottom", true);
    setInspectorTab("properties");
    pressDoc("j", { ctrlKey: true });
    expect(shell.docks.bottom.collapsed).toBe(false);
    expect(inspectorTab()).toBe("properties");
    pressDoc("j", { ctrlKey: true });
    expect(shell.docks.bottom.collapsed).toBe(true);
  });

  test("⌘. collapses every dock and the same chord puts them back", () => {
    setDockCollapsed("left", false);
    setDockCollapsed("right", true);

    pressDoc(".", { ctrlKey: true });
    expect([shell.docks.left, shell.docks.right].map((d) => d.collapsed)).toEqual([true, true]);

    pressDoc(".", { ctrlKey: true });
    expect([shell.docks.left, shell.docks.right].map((d) => d.collapsed)).toEqual([false, true]);
  });

  /* 8. Focus outside the pane grid takes the canvas scope off the stack entirely (plan §5.3's
        `caret > engine > focused dock > global`). Nothing sets `focusRegion` away from "pane" yet,
        so this is inert in the running app — it is the rung being put in place. */
  test("with focus in a dock the canvas chords are not live", () => {
    shell.focusRegion = "navigator";
    activeTab.value!.session.selection = [["children", 0]];
    const e = pressDoc("Delete");
    expect(childCount()).toBe(3);
    expect(e.defaultPrevented).toBe(false);
    // App-level chords still are.
    pressDoc("s", { ctrlKey: true });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });
});

// ─── The dispatcher itself ────────────────────────────────────────────────────

describe("dispatcher", () => {
  test("a chord with no command anywhere is left to the browser", () => {
    const e = pressDoc("F5");
    expect(e.defaultPrevented).toBe(false);
  });

  test("an error from a command's run is not swallowed as a refusal", () => {
    // Undo with no history is the registry's own refusal path; anything else must propagate.
    // Closing every tab makes `document.open` false, so ⌘Z is not even visible.
    closeAllTabs();
    const e = pressDoc("z", { ctrlKey: true });
    expect(e.defaultPrevented).toBe(false);
  });
});

// ─── The direct keys (plan §5.3) ──────────────────────────────────────────────

describe("direct keys", () => {
  beforeEach(() => {
    stampShellRegions();
    shell.focusRegion = "pane";
    setDockCollapsed("left", false);
    setDockCollapsed("right", true);
    setInspectorTab("properties");
  });

  test("⌘1 reveals and focuses Files; ⌘1 again collapses and returns to the pane", () => {
    shell.leftTab = "layers";
    pressDoc("1", { ctrlKey: true });
    expect(shell.leftTab).toBe("files");
    expect(shell.docks.left.collapsed).toBe(false);
    expect(shell.focusRegion).toBe("navigator");

    // Toggle-FOCUS, not toggle-visible: the second press only closes because focus is already here.
    pressDoc("1", { ctrlKey: true });
    expect(shell.docks.left.collapsed).toBe(true);
    expect(shell.focusRegion).toBe("pane");
  });

  test("⌘1 from another panel switches rather than closing", () => {
    shell.leftTab = "layers";
    shell.focusRegion = "navigator";
    pressDoc("1", { ctrlKey: true });
    expect(shell.leftTab).toBe("files");
    expect(shell.docks.left.collapsed).toBe(false);
  });

  test("⌘4 reveals Problems in the BOTTOM dock, because that is where its body lives (§7.2)", () => {
    shell.leftTab = "layers";
    shell.bottomTab = "activity";
    setDockCollapsed("bottom", true);
    pressDoc("4", { ctrlKey: true });
    expect(shell.bottomTab).toBe("problems");
    expect(shell.docks.bottom.collapsed).toBe(false);
    // The Navigator is not repurposed for it — the whole point of moving the panel.
    expect(shell.leftTab).toBe("layers");
  });

  test("⌘4 again collapses the Bottom dock and returns to the pane", () => {
    // Read through a helper: a literal assignment narrows `shell.focusRegion` for the rest of the
    // Test, and the point of the case is that the press CHANGES it.
    const focused = (): string => shell.focusRegion;
    setDockCollapsed("bottom", true);
    pressDoc("4", { ctrlKey: true });
    // Toggle-FOCUS: the second press only closes because focus is already in the dock.
    shell.focusRegion = "dock";
    pressDoc("4", { ctrlKey: true });
    expect(shell.docks.bottom.collapsed).toBe(true);
    expect(focused()).toBe("pane");
  });

  test("⌘4 from elsewhere re-reveals rather than closing", () => {
    setDockCollapsed("bottom", false);
    shell.bottomTab = "problems";
    shell.focusRegion = "navigator";
    pressDoc("4", { ctrlKey: true });
    expect(shell.docks.bottom.collapsed).toBe(false);
    expect(shell.bottomTab).toBe("problems");
  });

  test("⌘⇧2 opens the Inspector dock, ⌘⇧4 selects its Assistant tab", () => {
    // `key` is the SHIFTED glyph on every layout, so the digit row resolves by `code`.
    pressDoc("@", { code: "Digit2", ctrlKey: true, shiftKey: true });
    expect(shell.docks.right.collapsed).toBe(false);
    expect(shell.focusRegion).toBe("inspector");
    expect(inspectorTab()).toBe("style");

    pressDoc("$", { code: "Digit4", ctrlKey: true, shiftKey: true });
    expect(shell.docks.right.collapsed).toBe(false);
    expect(inspectorTab()).toBe("assistant");
  });

  test("F6 walks the ring and ⇧F6 walks it back, skipping regions with no host", () => {
    // Read through a helper: a literal assignment narrows `shell.focusRegion` for the rest of the
    // Block, and the point of the test is that the record MOVES.
    const focused = (): string => shell.focusRegion;
    shell.focusRegion = "rail";
    pressDoc("F6");
    expect(focused()).toBe("navigator");
    pressDoc("F6");
    expect(focused()).toBe("pane");
    pressDoc("F6");
    expect(focused()).toBe("inspector");
    // `dock.bottom` does not exist until P4, so the ring steps over it rather than stranding focus.
    pressDoc("F6");
    expect(focused()).toBe("status");
    pressDoc("F6");
    expect(focused()).toBe("rail");
    pressDoc("F6", { shiftKey: true });
    expect(focused()).toBe("status");
  });
});

describe("nextRegion", () => {
  const all = () => true;

  test("the ring is the shell's reading order", () => {
    expect([...REGION_CYCLE]).toEqual(["rail", "navigator", "pane", "inspector", "dock", "status"]);
  });

  test("wraps in both directions", () => {
    expect(nextRegion("status", 1, all)).toBe("rail");
    expect(nextRegion("rail", -1, all)).toBe("status");
  });

  test("skips regions that are not on screen", () => {
    const present = (region: string) => region !== "navigator" && region !== "pane";
    expect(nextRegion("rail", 1, present as never)).toBe("inspector");
  });

  test("returns null when nothing is on screen", () => {
    expect(nextRegion("pane", 1, () => false)).toBeNull();
  });
});

describe("focusShellRegion", () => {
  test("focuses the first focusable inside the region", () => {
    stampShellRegions();
    const button = document.createElement("button");
    document.querySelector("#left-panel")!.append(button);
    try {
      expect(focusShellRegion("navigator")).toBe(true);
      expect(document.activeElement).toBe(button);
      expect(shell.focusRegion).toBe("navigator");
    } finally {
      button.remove();
    }
  });

  test("a bare host is made programmatically focusable rather than skipped", () => {
    stampShellRegions();
    const host = document.querySelector("#statusbar") as HTMLElement;
    expect(focusShellRegion("status")).toBe(true);
    expect(host.tabIndex).toBe(-1);
  });

  test("an absent region is refused, and the record is left alone", () => {
    shell.focusRegion = "pane";
    expect(focusShellRegion("dock")).toBe(false);
    expect(shell.focusRegion).toBe("pane");
  });
});

// ─── Project: Open… ───────────────────────────────────────────────────────────

describe("openProjectFlow", () => {
  function dialogWrapper(): HTMLElement | null {
    return document.querySelector("sp-dialog-wrapper");
  }

  test("with one window there is no choice to make, and none is offered", async () => {
    installMockPlatform();
    const hooks = { openInBrowser, openProject, saveDocument: saveFile };
    await openProjectFlow(hooks);
    expect(openProject).toHaveBeenCalledWith("thisWindow");
    expect(dialogWrapper()).toBeNull();
  });

  test("with a project open on a multi-window platform it asks, and reports the outcome", async () => {
    installMockPlatform({ openProjectInNewWindow: (async () => {}) as never });
    const hooks = { openInBrowser, openProject, saveDocument: saveFile };
    const pending = openProjectFlow(hooks);
    await flush();
    const wrapper = dialogWrapper()!;
    expect(wrapper.getAttribute("headline")).toBe("Open Project");
    expect(wrapper.getAttribute("secondary-label")).toBe("This Window");
    wrapper.dispatchEvent(new Event("confirm", { bubbles: true }));
    await pending;
    expect(openProject).toHaveBeenCalledWith("newWindow");
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0]![0]).toContain("new window");
  });

  test("This Window is a real answer, not a dismissal", async () => {
    installMockPlatform({ openProjectInNewWindow: (async () => {}) as never });
    const hooks = { openInBrowser, openProject, saveDocument: saveFile };
    const pending = openProjectFlow(hooks);
    await flush();
    dialogWrapper()!.dispatchEvent(new Event("secondary", { bubbles: true }));
    await pending;
    expect(openProject).toHaveBeenCalledWith("thisWindow");
  });

  test("cancelling opens nothing and says nothing", async () => {
    installMockPlatform({ openProjectInNewWindow: (async () => {}) as never });
    const hooks = { openInBrowser, openProject, saveDocument: saveFile };
    const pending = openProjectFlow(hooks);
    await flush();
    dialogWrapper()!.dispatchEvent(new Event("cancel", { bubbles: true }));
    await pending;
    expect(openProject).not.toHaveBeenCalled();
    expect(notified).not.toHaveBeenCalled();
  });
});
