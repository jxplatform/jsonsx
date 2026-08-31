/**
 * Edit-width tests — the store (`src/canvas/edit-width.ts`) and the drag
 * (`src/canvas/edit-width-drag.ts`) that writes through it.
 *
 * Happy-dom lays nothing out, so every geometry branch is driven through `stubRect`; the drag is
 * dispatched as the bubbling pointer triples `tests/panel-resize.test.ts` established.
 */
import {
  installMockPlatform,
  resetStudioState,
  resetWorkspaceWithTab,
  standUpPaneGrid,
} from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initShellRefs } from "../src/store";
import {
  EDIT_CANVAS_GUTTER,
  EDIT_WIDTH_MIN,
  clearEditWidth,
  declaredWidthOfTab,
  editWidthOfPane,
  resetEditWidths,
  resolveEditColumnWidth,
  setEditWidth,
  snapTargetsOfTab,
} from "../src/canvas/edit-width";
import {
  applyEditWidth,
  editWidthTarget,
  mountEditWidthHandle,
} from "../src/canvas/edit-width-drag";
import { unregisterCanvasSurface } from "../src/canvas/canvas-surface";
import { activeTab, closeAllTabs, PRIMARY_PANE } from "../src/workspace/workspace";
import type { Tab } from "../src/tabs/tab";
import type { CanvasSurface } from "../src/canvas/canvas-surface";

/** The desktop-first shape `packages/create/templates.ts` ships and all 12 starters use. */
const DESKTOP_FIRST = {
  "--": "1200px",
  "--lg": "(max-width: 1024px)",
  "--md": "(max-width: 768px)",
  "--sm": "(max-width: 640px)",
};

let surface: CanvasSurface;

function openTabWithMedia(media: Record<string, string> = DESKTOP_FIRST): Tab {
  resetWorkspaceWithTab({
    $media: media,
    children: [{ tagName: "p", textContent: "Hi" }],
    tagName: "div",
  } as never);
  return activeTab.value!;
}

/**
 * A column inside a scroll container, with a rect that FOLLOWS its own CSS.
 *
 * Happy-dom lays nothing out, and a static `stubRect` would be actively misleading here: the whole
 * point of the derived breakpoint is that it is read back from what the column actually rendered
 * at. So the rect is a live getter over `width: 100%` under a `max-width` — exactly the two rules
 * `styles/canvas.css` gives the real column — and `clientWidth`, which is what the drag's ceiling
 * reads, is fixed the way a browser fixes it (padding included).
 */
function standUpColumn(available: number, initialWidth?: number): HTMLElement {
  const canvas = document.createElement("div");
  canvas.className = "content-edit-canvas";
  Object.defineProperty(canvas, "clientWidth", { configurable: true, value: available });
  const column = document.createElement("div");
  column.className = "content-edit-column";
  if (initialWidth !== undefined) {
    column.style.maxWidth = `${initialWidth}px`;
  }
  canvas.append(column);
  surface.wrap.append(canvas);
  Object.defineProperty(column, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const cap = Number(column.style.maxWidth.replace("px", "") || Number.NaN);
      return { width: Math.min(Number.isNaN(cap) ? available : cap, available) } as DOMRect;
    },
  });
  return column;
}

beforeEach(() => {
  installMockPlatform();
  resetStudioState();
  resetEditWidths();
  document.body.innerHTML = `<div id="app"></div>`;
  initShellRefs();
  // StandUpPaneGrid registers the stage as this pane's surface; nothing else to wire.
  surface = standUpPaneGrid(PRIMARY_PANE);
});

afterEach(() => {
  unregisterCanvasSurface(PRIMARY_PANE);
  resetEditWidths();
  closeAllTabs();
});

// ─── The store ────────────────────────────────────────────────────────────────

describe("declaredWidthOfTab", () => {
  test("is the base width at Base, and the breakpoint's own width otherwise", () => {
    const tab = openTabWithMedia();
    expect(declaredWidthOfTab(tab)).toBe(1200);
    tab.session.ui.activeMedia = "--md";
    expect(declaredWidthOfTab(tab)).toBe(768);
  });

  test("falls back to the base width for a breakpoint the document no longer declares", () => {
    const tab = openTabWithMedia();
    tab.session.ui.activeMedia = "--ghost";
    expect(declaredWidthOfTab(tab)).toBe(1200);
  });

  test("a document with no $media at all uses parseMediaEntries' 320px floor", () => {
    const tab = openTabWithMedia({});
    expect(declaredWidthOfTab(tab)).toBe(320);
  });
});

describe("snapTargetsOfTab", () => {
  test("offers the base width and every declared breakpoint", () => {
    expect(snapTargetsOfTab(openTabWithMedia()).toSorted((a, b) => a - b)).toEqual([
      640, 768, 1024, 1200,
    ]);
  });

  test("a project declaring only feature queries has the base width as its one magnet", () => {
    const tab = openTabWithMedia({ "--": "900px", "--dark": "(prefers-color-scheme: dark)" });
    expect(snapTargetsOfTab(tab)).toEqual([900]);
  });
});

describe("setEditWidth / editWidthOfPane", () => {
  test("records the width and derives the breakpoint the canvas is now in", () => {
    const tab = openTabWithMedia();
    expect(setEditWidth(PRIMARY_PANE, tab, 700)).toBe("--md");
    expect(tab.session.ui.activeMedia).toBe("--md");
    expect(editWidthOfPane(PRIMARY_PANE, tab)).toBe(700);
  });

  test("a width past every max-width query is Base", () => {
    const tab = openTabWithMedia();
    expect(setEditWidth(PRIMARY_PANE, tab, 1150)).toBeNull();
    expect(tab.session.ui.activeMedia).toBeNull();
  });

  test("the record self-invalidates when someone ELSE moves the breakpoint axis", () => {
    /* This is what lets `canvas.setBreakpoint` snap the column back to a declared width without
       `canvas-utils.ts` having to import the drag — see the module header. */
    const tab = openTabWithMedia();
    setEditWidth(PRIMARY_PANE, tab, 700);
    expect(editWidthOfPane(PRIMARY_PANE, tab)).toBe(700);
    tab.session.ui.activeMedia = "--sm";
    expect(editWidthOfPane(PRIMARY_PANE, tab)).toBeNull();
  });

  test("a stale record is DELETED, so returning to the breakpoint cannot revive it", () => {
    const tab = openTabWithMedia();
    setEditWidth(PRIMARY_PANE, tab, 700);
    tab.session.ui.activeMedia = "--sm";
    expect(editWidthOfPane(PRIMARY_PANE, tab)).toBeNull();
    tab.session.ui.activeMedia = "--md";
    expect(editWidthOfPane(PRIMARY_PANE, tab)).toBeNull();
  });

  test("a record does not follow the pane to another document", () => {
    const first = openTabWithMedia();
    setEditWidth(PRIMARY_PANE, first, 700);
    // `resetWorkspaceWithTab` mints one fixed id, so the other document is named directly.
    const second = { id: "another-tab", session: { ui: { activeMedia: null } } } as unknown as Tab;
    expect(editWidthOfPane(PRIMARY_PANE, second)).toBeNull();
    expect(editWidthOfPane(PRIMARY_PANE, first)).toBeNull();
  });

  test("no tab means no width", () => {
    expect(editWidthOfPane(PRIMARY_PANE, null)).toBeNull();
  });

  test("clearEditWidth and resetEditWidths both forget it", () => {
    const tab = openTabWithMedia();
    setEditWidth(PRIMARY_PANE, tab, 700);
    clearEditWidth(PRIMARY_PANE);
    expect(editWidthOfPane(PRIMARY_PANE, tab)).toBeNull();
    setEditWidth(PRIMARY_PANE, tab, 700);
    resetEditWidths();
    expect(editWidthOfPane(PRIMARY_PANE, tab)).toBeNull();
  });
});

describe("resolveEditColumnWidth", () => {
  test("prefers the dragged width, and falls back to the switcher's", () => {
    const tab = openTabWithMedia();
    expect(resolveEditColumnWidth(surface, tab)).toBe(1200);
    setEditWidth(PRIMARY_PANE, tab, 700);
    expect(resolveEditColumnWidth(surface, tab)).toBe(700);
  });

  test("an empty pane resolves to zero rather than throwing", () => {
    expect(resolveEditColumnWidth(surface, null)).toBe(0);
  });
});

// ─── The drag ─────────────────────────────────────────────────────────────────

describe("applyEditWidth", () => {
  test("writes the column, the readout and the derived breakpoint together", () => {
    const tab = openTabWithMedia();
    const column = standUpColumn(1400);
    applyEditWidth(surface, column, 700);
    expect(column.style.maxWidth).toBe("700px");
    expect(column.classList.contains("is-resizing")).toBe(true);
    expect(tab.session.ui.activeMedia).toBe("--md");
    expect(column.dataset.editWidth).toBe("700px");
  });

  test("the breakpoint comes from the MEASURED width, not the requested one", () => {
    /* The column is `width: 100%` under a `max-width`, so a pane narrower than the request renders
       narrower than it — and a band computed from the request would name one the page is not in. */
    const tab = openTabWithMedia();
    const column = standUpColumn(600);
    applyEditWidth(surface, column, 1150);
    expect(tab.session.ui.activeMedia).toBe("--sm");
    expect(editWidthOfPane(PRIMARY_PANE, tab)).toBe(600);
  });

  test("an empty pane is a no-op", () => {
    closeAllTabs();
    const column = standUpColumn(1400);
    applyEditWidth(surface, column, 700);
    expect(column.style.maxWidth).toBe("");
  });
});

describe("editWidthTarget", () => {
  test("scale is doubled and mirrored, which is what makes the two handles symmetric", () => {
    openTabWithMedia();
    const column = standUpColumn(1400);
    expect(editWidthTarget(surface, column, 1).scale()).toBe(2);
    expect(editWidthTarget(surface, column, -1).scale()).toBe(-2);
  });

  test("the ceiling is the container's width less both gutters, read fresh", () => {
    openTabWithMedia();
    const column = standUpColumn(1000);
    expect(editWidthTarget(surface, column, 1).max()).toBe(1000 - 2 * EDIT_CANVAS_GUTTER);
  });

  test("before layout there is no honest ceiling, so only the floor bounds the drag", () => {
    openTabWithMedia();
    const column = standUpColumn(0);
    const target = editWidthTarget(surface, column, 1);
    expect(target.max()).toBe(Number.POSITIVE_INFINITY);
    expect(target.min()).toBe(EDIT_WIDTH_MIN);
  });

  test("read is the measured width; reset is the breakpoint the switcher names", () => {
    const tab = openTabWithMedia();
    const column = standUpColumn(1400, 830);
    const target = editWidthTarget(surface, column, 1);
    expect(target.read()).toBe(830);
    expect(target.reset()).toBe(1200);
    tab.session.ui.activeMedia = "--md";
    expect(target.reset()).toBe(768);
  });

  test("read falls back to the declared width when nothing has been laid out", () => {
    // A pane that has not been laid out measures zero; starting a drag from zero would be a jump.
    openTabWithMedia();
    const column = standUpColumn(0);
    expect(editWidthTarget(surface, column, 1).read()).toBe(1200);
  });

  test("an empty pane still answers with the floor rather than throwing", () => {
    closeAllTabs();
    const column = standUpColumn(0);
    const target = editWidthTarget(surface, column, 1);
    expect(target.read()).toBe(EDIT_WIDTH_MIN);
    expect(target.reset()).toBe(EDIT_WIDTH_MIN);
    expect(target.snap?.(742, { altKey: false, shiftKey: false })).toBe(742);
  });

  test("snap pulls onto a declared width, and Alt passes straight through", () => {
    openTabWithMedia();
    const column = standUpColumn(1400);
    const { snap } = editWidthTarget(surface, column, 1);
    expect(snap?.(765, { altKey: false, shiftKey: false })).toBe(768);
    expect(snap?.(765, { altKey: true, shiftKey: false })).toBe(765);
    expect(snap?.(700, { altKey: false, shiftKey: false })).toBe(700);
  });

  test("settle closes the readout", () => {
    openTabWithMedia();
    const column = standUpColumn(1400);
    applyEditWidth(surface, column, 700);
    expect(column.classList.contains("is-resizing")).toBe(true);
    editWidthTarget(surface, column, 1).settle();
    expect(column.classList.contains("is-resizing")).toBe(false);
  });
});

describe("mountEditWidthHandle", () => {
  function handleIn(column: HTMLElement): HTMLElement {
    const handle = document.createElement("div");
    handle.className = "edit-width-handle end";
    column.append(handle);
    return handle;
  }

  function drag(handle: HTMLElement, from: number, to: number, init: MouseEventInit = {}) {
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: from }));
    handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: to, ...init }));
    handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: to }));
  }

  test("a drag on the end handle resizes symmetrically — 2px of width per px of pointer", () => {
    const tab = openTabWithMedia();
    const column = standUpColumn(1400, 1000);
    mountEditWidthHandle(surface, handleIn(column), 1);
    drag(column.lastElementChild as HTMLElement, 0, -60);
    // 1000 − 2×60 = 880, past no magnet, so it lands exactly there.
    expect(column.style.maxWidth).toBe("880px");
    expect(tab.session.ui.activeMedia).toBe("--lg");
  });

  test("the start handle grows the column when it is dragged LEFT", () => {
    openTabWithMedia();
    const column = standUpColumn(1400, 800);
    const handle = handleIn(column);
    handle.className = "edit-width-handle start";
    mountEditWidthHandle(surface, handle, -1);
    drag(handle, 0, -50);
    expect(column.style.maxWidth).toBe("900px");
  });

  test("a drag near a declared width snaps onto it", () => {
    const tab = openTabWithMedia();
    const column = standUpColumn(1400, 1000);
    mountEditWidthHandle(surface, handleIn(column), 1);
    // 1000 − 2×117 = 766, within 8px of the 768 the project declares for --md.
    drag(column.lastElementChild as HTMLElement, 0, -117);
    expect(column.style.maxWidth).toBe("768px");
    expect(tab.session.ui.activeMedia).toBe("--md");
  });

  test("Alt drags through the magnet", () => {
    openTabWithMedia();
    const column = standUpColumn(1400, 1000);
    mountEditWidthHandle(surface, handleIn(column), 1);
    drag(column.lastElementChild as HTMLElement, 0, -117, { altKey: true });
    expect(column.style.maxWidth).toBe("766px");
  });

  test("the drag is clamped by the pane, and a magnet cannot carry it past the wall", () => {
    /* The container is 1000 wide, so the ceiling is 968 — below the 1024 the project declares for
       --lg. Without the re-clamp in `setupHandle`, that magnet would win and the stored width, the
       readout and the rendered column would then disagree. */
    openTabWithMedia();
    const column = standUpColumn(1000, 900);
    mountEditWidthHandle(surface, handleIn(column), 1);
    drag(column.lastElementChild as HTMLElement, 0, 400);
    expect(column.style.maxWidth).toBe(`${1000 - 2 * EDIT_CANVAS_GUTTER}px`);
  });

  test("mounting twice does not stack a second gesture on one element", () => {
    openTabWithMedia();
    const column = standUpColumn(1400, 1000);
    const handle = handleIn(column);
    mountEditWidthHandle(surface, handle, 1);
    mountEditWidthHandle(surface, handle, 1);
    drag(handle, 0, -60);
    // Wired twice, the second listener would read a startSize the first had already moved.
    expect(column.style.maxWidth).toBe("880px");
  });

  test("lit calls a ref with undefined on disconnect, and an orphan handle is skipped", () => {
    openTabWithMedia();
    expect(() => mountEditWidthHandle(surface, undefined, 1)).not.toThrow();
    expect(() => mountEditWidthHandle(surface, document.createElement("div"), 1)).not.toThrow();
  });
});
