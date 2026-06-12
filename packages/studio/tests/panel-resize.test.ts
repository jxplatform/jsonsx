import "./harness";
import { describe, expect, test } from "bun:test";

const STORAGE_KEY = "jx-studio-panel-widths";
const root = document.documentElement;

// Panel-resize is a self-initializing module: it restores saved widths/collapse state and binds
// The resize handles at import time, so the fixture must exist before the dynamic import below.
localStorage.setItem(
  STORAGE_KEY,
  JSON.stringify({ left: 300, leftCollapsed: true, right: 320, rightCollapsed: true }),
);
document.body.innerHTML = `
  <div id="app"></div>
  <div id="resize-left"></div>
  <div id="resize-right"></div>
`;

const { view } = await import("../src/view");
await import("../src/ui/panel-resize");

const leftHandle = document.querySelector("#resize-left") as HTMLElement;
const rightHandle = document.querySelector("#resize-right") as HTMLElement;

function drag(handle: HTMLElement, type: string, clientX: number) {
  handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
}

function widthOf(cssVar: string): string {
  return root.style.getPropertyValue(cssVar);
}

/** Start width the handler will read back for a var (computed style, falling back to default). */
function startWidth(cssVar: string, fallback: number): number {
  return Number.parseInt(getComputedStyle(root).getPropertyValue(cssVar), 10) || fallback;
}

describe("import-time restore", () => {
  test("saved widths are applied to the root custom properties", () => {
    expect(widthOf("--panel-w-left")).toBe("300px");
    expect(widthOf("--panel-w-right")).toBe("320px");
  });

  test("saved collapse flags restore view state and #app classes", () => {
    expect(view.leftPanelCollapsed).toBe(true);
    expect(view.rightPanelCollapsed).toBe(true);
    const app = document.querySelector("#app") as HTMLElement;
    expect(app.classList.contains("left-collapsed")).toBe(true);
    expect(app.classList.contains("right-collapsed")).toBe(true);
  });
});

describe("left handle drag", () => {
  test("pointermove without an active drag is a no-op", () => {
    const before = widthOf("--panel-w-left");
    drag(leftHandle, "pointermove", 500);
    expect(widthOf("--panel-w-left")).toBe(before);
  });

  test("pointerdown marks the handle and disables text selection", () => {
    drag(leftHandle, "pointerdown", 100);
    expect(leftHandle.classList.contains("dragging")).toBe(true);
    expect(document.body.style.userSelect).toBe("none");
    drag(leftHandle, "pointerup", 100);
  });

  test("dragging right grows the left panel by the pointer delta", () => {
    const start = startWidth("--panel-w-left", 240);
    drag(leftHandle, "pointerdown", 100);
    drag(leftHandle, "pointermove", 150);
    expect(widthOf("--panel-w-left")).toBe(`${start + 50}px`);
    drag(leftHandle, "pointerup", 150);
  });

  test("width clamps to the 160px minimum and 50% viewport maximum", () => {
    drag(leftHandle, "pointerdown", 100);
    drag(leftHandle, "pointermove", -100_000);
    expect(widthOf("--panel-w-left")).toBe("160px");
    drag(leftHandle, "pointermove", 100_000);
    expect(widthOf("--panel-w-left")).toBe(`${Math.round(window.innerWidth * 0.5)}px`);
    drag(leftHandle, "pointerup", 100_000);
  });

  test("pointerup ends the drag, restores selection, and persists widths", () => {
    localStorage.removeItem(STORAGE_KEY);
    drag(leftHandle, "pointerdown", 100);
    drag(leftHandle, "pointermove", 120);
    drag(leftHandle, "pointerup", 120);
    expect(leftHandle.classList.contains("dragging")).toBe(false);
    expect(document.body.style.userSelect).toBe("");

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    expect(typeof saved.left).toBe("number");
    expect(typeof saved.right).toBe("number");

    // Subsequent moves after pointerup must not resize.
    const after = widthOf("--panel-w-left");
    drag(leftHandle, "pointermove", 400);
    expect(widthOf("--panel-w-left")).toBe(after);
    // A second pointerup with no active drag is also a no-op.
    drag(leftHandle, "pointerup", 400);
    expect(document.body.style.userSelect).toBe("");
  });

  test("double-click resets the left panel to its default width", () => {
    localStorage.removeItem(STORAGE_KEY);
    leftHandle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(widthOf("--panel-w-left")).toBe("240px");
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });
});

describe("right handle drag", () => {
  test("dragging left grows the right panel (inverted delta)", () => {
    const start = startWidth("--panel-w-right", 280);
    drag(rightHandle, "pointerdown", 500);
    drag(rightHandle, "pointermove", 460);
    expect(widthOf("--panel-w-right")).toBe(`${start + 40}px`);
    drag(rightHandle, "pointerup", 460);
  });

  test("double-click resets the right panel to its default width", () => {
    rightHandle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(widthOf("--panel-w-right")).toBe("280px");
  });
});
