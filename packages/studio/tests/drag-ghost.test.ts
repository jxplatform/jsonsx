/**
 * Tests for src/panels/drag-ghost.ts — the cross-frame drag ghost layer (Phase 4c). Asserts the DOM
 * placement (a single fixed element following the raw cursor 1:1) and show/move/clear behavior. The
 * real cross-realm zoom-invariance (ghost OUTSIDE the scaled wrap) is CDP-only; here we only prove
 * the element is `position:fixed` and tracks clientX/clientY.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { clearDragGhost, moveDragGhost, setDragGhost } from "../src/panels/drag-ghost";

function ghost(): HTMLElement | null {
  return document.querySelector(".jx-drag-ghost");
}

beforeEach(() => {
  // The module reuses one lazily-created element; remove it so each test starts clean.
  ghost()?.remove();
});

describe("setDragGhost", () => {
  test("lazily creates one fixed, non-interactive element at the cursor with the label", () => {
    setDragGhost("section", 120, 80);
    const el = ghost()!;
    expect(el).toBeTruthy();
    expect(el.style.position).toBe("fixed");
    expect(el.style.pointerEvents).toBe("none");
    expect(el.textContent).toBe("section");
    expect(el.style.left).toBe("120px");
    expect(el.style.top).toBe("80px");
    expect(el.style.display).toBe("block");
  });

  test("reuses the same element across shows (no duplicate ghosts)", () => {
    setDragGhost("a", 1, 1);
    setDragGhost("b", 2, 2);
    expect(document.querySelectorAll(".jx-drag-ghost")).toHaveLength(1);
    expect(ghost()!.textContent).toBe("b");
  });
});

describe("moveDragGhost", () => {
  test("repositions the visible ghost without changing its label", () => {
    setDragGhost("p", 10, 10);
    moveDragGhost(33, 44);
    const el = ghost()!;
    expect(el.style.left).toBe("33px");
    expect(el.style.top).toBe("44px");
    expect(el.textContent).toBe("p");
  });

  test("is a no-op when the ghost is hidden", () => {
    setDragGhost("p", 10, 10);
    clearDragGhost();
    moveDragGhost(99, 99);
    expect(ghost()!.style.left).toBe("10px");
  });
});

describe("clearDragGhost", () => {
  test("hides the ghost but retains the element for reuse", () => {
    setDragGhost("p", 10, 10);
    clearDragGhost();
    expect(ghost()!.style.display).toBe("none");
  });

  test("is safe to call before any ghost exists", () => {
    expect(() => clearDragGhost()).not.toThrow();
  });
});
