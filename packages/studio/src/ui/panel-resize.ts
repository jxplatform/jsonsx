/// <reference lib="dom" />
/**
 * Panel-resize.js — Draggable resize handles for the left, right and assistant docks.
 *
 * Self-initializing module. Import it and the resize handles become interactive.
 *
 * The handles are the only thing here: dock widths, their persistence and their projection onto the
 * grid's CSS custom properties all belong to the reactive `shell` record (`../shell`). A drag
 * writes `setDockWidth()` and the shell's own effect moves the column; release persists once.
 */

import { DOCK_DEFAULT_WIDTHS, persistDocks, setDockWidth, shell } from "../shell";
import type { DockId } from "../shell";

const MIN_WIDTH = 160;
const MAX_RATIO = 0.5; // Max 50% of viewport

/** Which handle drives which dock, and which direction widens it. */
const HANDLES: { selector: string; dock: DockId; side: "left" | "right" }[] = [
  { dock: "left", selector: "#resize-left", side: "left" },
  { dock: "right", selector: "#resize-right", side: "right" },
  { dock: "chat", selector: "#resize-chat", side: "right" },
];

/**
 * Wire one handle to one dock.
 *
 * @param {HTMLElement} handle
 * @param {DockId} dock
 * @param {"left" | "right"} side — which way a rightward drag grows the dock
 */
function setupHandle(handle: HTMLElement, dock: DockId, side: "left" | "right") {
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
    drag = { startWidth: shell.docks[dock].width, startX: e.clientX };
  });

  handle.addEventListener("pointermove", (e) => {
    if (!drag) {
      return;
    }
    const delta = side === "left" ? e.clientX - drag.startX : drag.startX - e.clientX;
    const maxWidth = window.innerWidth * MAX_RATIO;
    const clamped = Math.max(MIN_WIDTH, drag.startWidth + delta);
    setDockWidth(dock, Math.round(Math.min(maxWidth, clamped)));
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
    persistDocks();
  });

  handle.addEventListener("dblclick", () => {
    setDockWidth(dock, DOCK_DEFAULT_WIDTHS[dock]);
    persistDocks();
  });
}

/** Attach every handle present in the document. Idempotent per element by construction. */
export function mountPanelResize(): void {
  for (const { dock, selector, side } of HANDLES) {
    const handle = document.querySelector<HTMLElement>(selector);
    if (handle) {
      setupHandle(handle, dock, side);
    }
  }
}

mountPanelResize();
