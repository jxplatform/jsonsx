/**
 * Tests for src/editor/insertion-helper.ts — the floating "+" insertion button.
 *
 * Drives the helper through mount → mousemove edge detection → click → slash-menu selection →
 * document insertion, plus hide/cancel timing and the Observable-element mount branch.
 */
import { flush, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mount, unmount } from "../src/editor/insertion-helper";
import { dismissSlashMenu, isSlashMenuOpen } from "../src/editor/slash-menu";
import { childIndex, getNodeAtPath, parentElementPath } from "../src/store";
import { activeTab } from "../src/workspace/workspace";

import type { JxPath } from "../src/state";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HIDE_WAIT = 360; // HIDE_DELAY (300ms) + margin

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let viewport: HTMLElement;
let canvas: HTMLElement;
let rootEl: HTMLElement;
let elToPath: WeakMap<Element, JxPath>;
let canvasMode = "design";
let hitEl: Element | null = null;
const realElementFromPoint = document.elementFromPoint;

function makeCtx(panelOverrides: Record<string, unknown> = {}) {
  return {
    childIndex: (path: JxPath) => childIndex(path) as string | number,
    defaultDef: (tag: string) => ({ children: [], tagName: tag }) as JxMutableNode,
    effectiveZoom: () => 1,
    elToPath,
    getCanvasMode: () => canvasMode,
    getNodeAtPath: (doc: JxMutableNode, path: JxPath) => getNodeAtPath(doc, path) ?? null,
    panel: { canvas, viewport, ...panelOverrides } as never,
    parentElementPath,
    withPanelPointerEvents: (fn: () => unknown) => fn(),
  };
}

function helperEl(): HTMLElement | null {
  return viewport.querySelector(".insertion-helper");
}

function moveMouse(clientX: number, clientY: number) {
  viewport.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }));
}

beforeEach(() => {
  canvasMode = "design";
  elToPath = new WeakMap();
  viewport = document.createElement("div");
  canvas = document.createElement("div");
  rootEl = document.createElement("div");
  canvas.append(rootEl);
  viewport.append(canvas);
  document.body.append(viewport);

  // Happy-dom performs no layout — route hit-testing through a controllable stub.
  (document as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint =
    () => hitEl;

  resetWorkspaceWithTab({
    children: [
      { tagName: "p", textContent: "A" },
      { tagName: "p", textContent: "B" },
    ],
    tagName: "div",
  });
});

afterEach(() => {
  unmount();
  dismissSlashMenu();
  hitEl = null;
  viewport.remove();
  (document as { elementFromPoint: typeof realElementFromPoint }).elementFromPoint =
    realElementFromPoint;
});

/** Append a child element to the canvas root mapped to a document path. */
function addChild(tag: string, path: JxPath, cls = "") {
  const el = document.createElement(tag);
  if (cls) {
    el.className = cls;
  }
  rootEl.append(el);
  elToPath.set(el, path);
  return el;
}

// ─── Mount / unmount ─────────────────────────────────────────────────────────

describe("mount/unmount", () => {
  test("mount appends the + button to the viewport", () => {
    mount(makeCtx());
    const helper = helperEl();
    expect(helper).not.toBeNull();
    expect(helper!.textContent).toBe("+");
    expect(helper!.tagName.toLowerCase()).toBe("button");
  });

  test("unmount removes the button and is idempotent", () => {
    mount(makeCtx());
    unmount();
    expect(helperEl()).toBeNull();
    unmount(); // Safe second call
    expect(helperEl()).toBeNull();
  });

  test("mousemove after unmount does nothing", () => {
    mount(makeCtx());
    const el = addChild("div", ["children", 0], "empty-container-placeholder");
    unmount();
    hitEl = el;
    moveMouse(10, 10);
    expect(helperEl()).toBeNull();
  });

  test("mount uses Observable .on() when the viewport supports it", () => {
    const subscriptions: Record<string, (e: MouseEvent) => void> = {};
    (viewport as unknown as Record<string, unknown>).on = (event: string) => ({
      subscribe: ({ next }: { next: (e: MouseEvent) => void }) => {
        subscriptions[event] = next;
      },
    });
    mount(makeCtx());
    expect(typeof subscriptions.mousemove).toBe("function");
    expect(typeof subscriptions.mouseleave).toBe("function");

    const el = addChild("div", ["children", 0], "empty-container-placeholder");
    hitEl = el;
    subscriptions.mousemove!(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
    expect(helperEl()!.classList.contains("visible")).toBe(true);
    delete (viewport as unknown as Record<string, unknown>).on;
  });
});

// ─── Edge detection ──────────────────────────────────────────────────────────

describe("edge detection", () => {
  test("empty container placeholder shows centered helper and sets anchor", () => {
    mount(makeCtx());
    const el = addChild("div", ["children", 0], "empty-container-placeholder");
    hitEl = el;
    moveMouse(50, 50);
    const helper = helperEl()!;
    expect(helper.classList.contains("visible")).toBe(true);
    expect(helper.dataset.edge).toBe("center");
    expect((el.style as unknown as Record<string, string>).anchorName).toBe("--jx-insert");
  });

  test("column layout: near top edge shows 'top', near bottom shows 'bottom'", () => {
    mount(makeCtx());
    const el = addChild("p", ["children", 0]);
    stubRect(el, { height: 100, left: 0, top: 100, width: 200 });
    hitEl = el;

    moveMouse(50, 105); // RelY = 5 < 14
    expect(helperEl()!.dataset.edge).toBe("top");

    moveMouse(50, 195); // Rect.height - relY = 5 < 14
    expect(helperEl()!.dataset.edge).toBe("bottom");
    expect(helperEl()!.classList.contains("visible")).toBe(true);
  });

  test("row (flex) layout: near left edge shows 'left', near right shows 'right'", () => {
    mount(makeCtx());
    rootEl.style.display = "flex";
    rootEl.style.flexDirection = "row";
    const el = addChild("p", ["children", 0]);
    stubRect(el, { height: 50, left: 100, top: 100, width: 300 });
    hitEl = el;

    moveMouse(105, 120); // RelX = 5 < 14
    expect(helperEl()!.dataset.edge).toBe("left");

    moveMouse(395, 120); // Rect.width - relX = 5 < 14
    expect(helperEl()!.dataset.edge).toBe("right");

    moveMouse(250, 120); // Horizontal middle — schedules hide (stays visible until delay)
    expect(helperEl()!.classList.contains("visible")).toBe(true);
  });

  test("anchor moves between elements as the cursor changes targets", () => {
    mount(makeCtx());
    const a = addChild("p", ["children", 0]);
    const b = addChild("p", ["children", 1]);
    stubRect(a, { height: 50, left: 0, top: 0, width: 200 });
    stubRect(b, { height: 50, left: 0, top: 50, width: 200 });

    hitEl = a;
    moveMouse(50, 2);
    expect((a.style as unknown as Record<string, string>).anchorName).toBe("--jx-insert");

    hitEl = b;
    moveMouse(50, 52);
    expect((a.style as unknown as Record<string, string>).anchorName).toBe("");
    expect((b.style as unknown as Record<string, string>).anchorName).toBe("--jx-insert");
  });

  test("middle of element hides the helper after the hide delay", async () => {
    mount(makeCtx());
    const el = addChild("p", ["children", 0]);
    stubRect(el, { height: 100, left: 0, top: 100, width: 200 });
    hitEl = el;

    moveMouse(50, 105);
    expect(helperEl()!.classList.contains("visible")).toBe(true);

    moveMouse(50, 150); // Middle — schedules hide
    expect(helperEl()!.classList.contains("visible")).toBe(true); // Not yet
    await sleep(HIDE_WAIT);
    expect(helperEl()!.classList.contains("visible")).toBe(false);
    expect((el.style as unknown as Record<string, string>).anchorName).toBe("");
  });

  test("hides for non-design modes, off-canvas hits, unmapped elements, and root path", async () => {
    mount(makeCtx());
    const el = addChild("div", ["children", 0], "empty-container-placeholder");

    // Visible first
    hitEl = el;
    moveMouse(10, 10);
    expect(helperEl()!.classList.contains("visible")).toBe(true);

    // Wrong canvas mode
    canvasMode = "preview";
    moveMouse(10, 10);
    await sleep(HIDE_WAIT);
    expect(helperEl()!.classList.contains("visible")).toBe(false);
    canvasMode = "design";

    // Hit outside the canvas
    moveMouse(10, 10);
    expect(helperEl()!.classList.contains("visible")).toBe(true);
    hitEl = document.body;
    moveMouse(10, 10);
    await sleep(HIDE_WAIT);
    expect(helperEl()!.classList.contains("visible")).toBe(false);

    // Element with no path mapping
    hitEl = el;
    moveMouse(10, 10);
    const unmapped = document.createElement("span");
    rootEl.append(unmapped);
    hitEl = unmapped;
    moveMouse(10, 10);
    await sleep(HIDE_WAIT);
    expect(helperEl()!.classList.contains("visible")).toBe(false);

    // Root path (length 0) — cannot insert siblings of root
    hitEl = el;
    moveMouse(10, 10);
    elToPath.set(rootEl, []);
    hitEl = rootEl;
    moveMouse(10, 10);
    await sleep(HIDE_WAIT);
    expect(helperEl()!.classList.contains("visible")).toBe(false);

    // Degenerate one-segment path — no parent element path
    hitEl = el;
    moveMouse(10, 10);
    const odd = addChild("p", ["children"] as unknown as JxPath);
    stubRect(odd, { height: 100, left: 0, top: 100, width: 200 });
    hitEl = odd;
    moveMouse(50, 105);
    await sleep(HIDE_WAIT);
    expect(helperEl()!.classList.contains("visible")).toBe(false);
  });

  test("hovering the helper cancels the scheduled hide", async () => {
    mount(makeCtx());
    const el = addChild("p", ["children", 0]);
    stubRect(el, { height: 100, left: 0, top: 100, width: 200 });
    hitEl = el;
    moveMouse(50, 105);

    moveMouse(50, 150); // Schedule hide
    helperEl()!.dispatchEvent(new MouseEvent("mouseenter"));
    await sleep(HIDE_WAIT);
    expect(helperEl()!.classList.contains("visible")).toBe(true);

    helperEl()!.dispatchEvent(new MouseEvent("mouseleave"));
    await sleep(HIDE_WAIT);
    expect(helperEl()!.classList.contains("visible")).toBe(false);
  });
});

// ─── Insertion flow ──────────────────────────────────────────────────────────

describe("insertion flow", () => {
  test("click with no insertion point does nothing", () => {
    mount(makeCtx());
    helperEl()!.click();
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("click opens the slash menu; Enter inserts into an empty container", async () => {
    resetWorkspaceWithTab({
      children: [{ children: [], tagName: "div" }],
      tagName: "div",
    });
    mount(makeCtx());
    const el = addChild("div", ["children", 0], "empty-container-placeholder");
    hitEl = el;
    moveMouse(10, 10);

    helperEl()!.click();
    expect(isSlashMenuOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush();

    const tab = activeTab.value!;
    const inserted = getNodeAtPath(tab.doc.document, ["children", 0, "children", 0]);
    expect(inserted?.tagName).toBe("h1"); // First slash command
    expect(tab.session.selection).toEqual(["children", 0, "children", 0]);
  });

  test("Enter inserts a sibling before the hovered element on the top edge", async () => {
    mount(makeCtx());
    const el = addChild("p", ["children", 1]);
    stubRect(el, { height: 100, left: 0, top: 100, width: 200 });
    hitEl = el;
    moveMouse(50, 105); // Top edge → idx 1

    helperEl()!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush();

    const tab = activeTab.value!;
    const children = tab.doc.document.children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[1]!.tagName).toBe("h1");
    expect(children[0]!.textContent).toBe("A");
    expect(children[2]!.textContent).toBe("B");
    expect(tab.session.selection).toEqual(["children", 1]);
  });

  test("Enter inserts a sibling after the hovered element on the bottom edge", async () => {
    mount(makeCtx());
    const el = addChild("p", ["children", 0]);
    stubRect(el, { height: 100, left: 0, top: 100, width: 200 });
    hitEl = el;
    moveMouse(50, 195); // Bottom edge → idx 1

    helperEl()!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush();

    const children = activeTab.value!.doc.document.children as JxMutableNode[];
    expect(children.length).toBe(3);
    expect(children[0]!.textContent).toBe("A");
    expect(children[1]!.tagName).toBe("h1");
  });
});
