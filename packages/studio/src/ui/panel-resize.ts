/// <reference lib="dom" />
/**
 * Panel-resize.js — Draggable resize handles for left and right sidebars.
 *
 * Self-initializing module. Import it and the resize handles become interactive. Persists widths to
 * localStorage so they survive page reloads.
 */

import { applyPanelCollapse, view } from "../view";

const STORAGE_KEY = "jx-studio-panel-widths";
const MIN_WIDTH = 160;
const MAX_RATIO = 0.5; // Max 50% of viewport
const DEFAULT_LEFT = 240;
const DEFAULT_RIGHT = 280;
const DEFAULT_CHAT = 320;

const root = document.documentElement;

/** Read a px-valued CSS custom property as a number (e.g. "320px" → 320). */
function readPxVar(cssVar: string): number {
  return Number(getComputedStyle(root).getPropertyValue(cssVar).replace(/px$/, ""));
}

// ─── Restore saved widths & collapse state ──────────────────────────────────

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as {
    left?: number;
    right?: number;
    chat?: number;
    leftCollapsed?: boolean;
    rightCollapsed?: boolean;
    chatCollapsed?: boolean;
  };
  if (saved.left) {
    root.style.setProperty("--panel-w-left", `${saved.left}px`);
  }
  if (saved.right) {
    root.style.setProperty("--panel-w-right", `${saved.right}px`);
  }
  if (saved.chat) {
    root.style.setProperty("--panel-w-chat", `${saved.chat}px`);
  }
  if (saved.leftCollapsed) {
    view.leftPanelCollapsed = true;
  }
  if (saved.rightCollapsed) {
    view.rightPanelCollapsed = true;
  }
  if (saved.chatCollapsed) {
    view.chatPanelCollapsed = true;
  }
  applyPanelCollapse();
} catch {
  // Ignore
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
      /* Synthetic events */
    }
    handle.classList.add("dragging");
    document.body.style.userSelect = "none";

    const current = readPxVar(cssVar) || defaultWidth;
    drag = { startWidth: current, startX: e.clientX };
  });

  handle.addEventListener("pointermove", (e) => {
    if (!drag) {
      return;
    }
    const delta = side === "left" ? e.clientX - drag.startX : drag.startX - e.clientX;
    const maxWidth = window.innerWidth * MAX_RATIO;
    const newWidth = Math.round(Math.min(maxWidth, Math.max(MIN_WIDTH, drag.startWidth + delta)));
    root.style.setProperty(cssVar, `${newWidth}px`);
  });

  handle.addEventListener("pointerup", (e) => {
    if (!drag) {
      return;
    }
    drag = null;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* Synthetic events */
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
  const left = readPxVar("--panel-w-left") || DEFAULT_LEFT;
  const right = readPxVar("--panel-w-right") || DEFAULT_RIGHT;
  const chat = readPxVar("--panel-w-chat") || DEFAULT_CHAT;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chat, left, right }));
  } catch {
    // Storage full or unavailable
  }
}

// ─── Initialize ──────────────────────────────────────────────────────────────

const resizeLeft = document.querySelector<HTMLElement>("#resize-left");
const resizeRight = document.querySelector<HTMLElement>("#resize-right");
const resizeChat = document.querySelector<HTMLElement>("#resize-chat");

if (resizeLeft) {
  setupHandle(resizeLeft, "--panel-w-left", "left", DEFAULT_LEFT);
}
if (resizeRight) {
  setupHandle(resizeRight, "--panel-w-right", "right", DEFAULT_RIGHT);
}
if (resizeChat) {
  setupHandle(resizeChat, "--panel-w-chat", "right", DEFAULT_CHAT);
}
