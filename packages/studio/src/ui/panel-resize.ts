/**
 * Panel-resize.js — Draggable resize handles for left and right sidebars.
 *
 * Self-initializing module. Import it and the resize handles become interactive. Persists widths to
 * localStorage so they survive page reloads.
 */

import { view, applyPanelCollapse } from "../view";

const STORAGE_KEY = "jx-studio-panel-widths";
const MIN_WIDTH = 160;
const MAX_RATIO = 0.5; // max 50% of viewport
const DEFAULT_LEFT = 240;
const DEFAULT_RIGHT = 280;

const root = document.documentElement;

// ─── Restore saved widths & collapse state ──────────────────────────────────

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  if (saved.left) root.style.setProperty("--panel-w-left", `${saved.left}px`);
  if (saved.right) root.style.setProperty("--panel-w-right", `${saved.right}px`);
  if (saved.leftCollapsed) view.leftPanelCollapsed = true;
  if (saved.rightCollapsed) view.rightPanelCollapsed = true;
  applyPanelCollapse();
} catch {
  // ignore
}

// ─── Setup handles ───────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} handle
 * @param {string} cssVar
 * @param {"left" | "right"} side
 * @param {number} defaultWidth
 */
function setupHandle(
  handle: HTMLElement,
  cssVar: string,
  side: "left" | "right",
  defaultWidth: number,
) {
  let drag: { startX: number; startWidth: number } | null = null;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    handle.classList.add("dragging");
    document.body.style.userSelect = "none";

    const current = parseInt(getComputedStyle(root).getPropertyValue(cssVar)) || defaultWidth;
    drag = { startX: e.clientX, startWidth: current };
  });

  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const delta = side === "left" ? e.clientX - drag.startX : drag.startX - e.clientX;
    const maxWidth = window.innerWidth * MAX_RATIO;
    const newWidth = Math.round(Math.min(maxWidth, Math.max(MIN_WIDTH, drag.startWidth + delta)));
    root.style.setProperty(cssVar, `${newWidth}px`);
  });

  handle.addEventListener("pointerup", (e) => {
    if (!drag) return;
    drag = null;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    handle.classList.remove("dragging");
    document.body.style.userSelect = "";
    persistWidths();
  });

  handle.addEventListener("dblclick", () => {
    root.style.setProperty(cssVar, `${defaultWidth}px`);
    persistWidths();
  });
}

function persistWidths() {
  const left = parseInt(getComputedStyle(root).getPropertyValue("--panel-w-left")) || DEFAULT_LEFT;
  const right =
    parseInt(getComputedStyle(root).getPropertyValue("--panel-w-right")) || DEFAULT_RIGHT;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, right }));
  } catch {
    // storage full or unavailable
  }
}

// ─── Initialize ──────────────────────────────────────────────────────────────

const resizeLeft = document.getElementById("resize-left");
const resizeRight = document.getElementById("resize-right");

if (resizeLeft) setupHandle(resizeLeft, "--panel-w-left", "left", DEFAULT_LEFT);
if (resizeRight) setupHandle(resizeRight, "--panel-w-right", "right", DEFAULT_RIGHT);
