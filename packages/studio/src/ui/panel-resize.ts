/// <reference lib="dom" />
/**
 * Panel-resize.js — Draggable resize handles for the three docks.
 *
 * Self-initializing module. Import it and the resize handles become interactive.
 *
 * The handles are the only thing here: dock sizes, their persistence and their projection onto the
 * grid's CSS custom properties all belong to the reactive `shell` record (`../shell`). A drag
 * writes `setDockSize()` and the shell's own effect moves the track; release persists once.
 */

import { DOCK_DEFAULT_SIZES, persistDocks, setDockSize, shell } from "../shell";
import type { DockId } from "../shell";

/**
 * The smallest a dock may be dragged to, per axis.
 *
 * The Bottom dock's floor is lower because its content is rows of text: 120px is four problems or
 * two activity rows, which is a useful dock, where 160px of a 24-row list is not meaningfully
 * more.
 */
const MIN_SIZE: Readonly<Record<"x" | "y", number>> = { x: 160, y: 120 };

/** The largest, as a fraction of the viewport along the dragged axis. */
const MAX_RATIO = 0.5;

/**
 * Which handle drives which dock, and which direction grows it.
 *
 * Three rows, and the third resizes on the other axis: `grow` is the sign a pointer moving in the
 * positive direction of `axis` contributes, so the Navigator grows rightward, and the Inspector and
 * the Bottom dock grow back toward the pointer's origin. The assistant is not here and never will
 * be — it is an Inspector TAB, resized by resizing the Inspector.
 */
const HANDLES: { selector: string; dock: DockId; axis: "x" | "y"; grow: 1 | -1 }[] = [
  { axis: "x", dock: "left", grow: 1, selector: "#resize-left" },
  { axis: "x", dock: "right", grow: -1, selector: "#resize-right" },
  { axis: "y", dock: "bottom", grow: -1, selector: "#resize-bottom" },
];

/**
 * Wire one handle to one dock.
 *
 * @param {HTMLElement} handle
 * @param {DockId} dock
 * @param {"x" | "y"} axis — which coordinate the drag reads
 * @param {1 | -1} grow — the sign a positive move along `axis` contributes to the dock's size
 */
function setupHandle(handle: HTMLElement, dock: DockId, axis: "x" | "y", grow: 1 | -1) {
  let drag: { start: number; startSize: number } | null = null;
  const coord = (e: { clientX: number; clientY: number }) => (axis === "x" ? e.clientX : e.clientY);

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* Synthetic events */
    }
    handle.classList.add("dragging");
    document.body.style.userSelect = "none";
    drag = { start: coord(e), startSize: shell.docks[dock].size };
  });

  handle.addEventListener("pointermove", (e) => {
    if (!drag) {
      return;
    }
    const delta = (coord(e) - drag.start) * grow;
    const maxSize = (axis === "x" ? window.innerWidth : window.innerHeight) * MAX_RATIO;
    const clamped = Math.max(MIN_SIZE[axis], drag.startSize + delta);
    setDockSize(dock, Math.round(Math.min(maxSize, clamped)));
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
    setDockSize(dock, DOCK_DEFAULT_SIZES[dock]);
    persistDocks();
  });
}

/** Attach every handle present in the document. Idempotent per element by construction. */
export function mountPanelResize(): void {
  for (const { axis, dock, grow, selector } of HANDLES) {
    const handle = document.querySelector<HTMLElement>(selector);
    if (handle) {
      setupHandle(handle, dock, axis, grow);
    }
  }
}

mountPanelResize();
