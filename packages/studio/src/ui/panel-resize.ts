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

import {
  DOCK_DEFAULT_SIZES,
  persistDocks,
  registerShellSurface,
  setDockSize,
  shell,
} from "../shell";
import type { DockId } from "../shell";

/**
 * What a handle drags.
 *
 * Generalised out of the three dock rows so the pane splitter can be the fourth. A dock is sized in
 * px and a pane split is a ratio, which is the whole of the difference: `scale` converts a pointer
 * delta in px into the target's own units, and everything else — capture, the dragging class, the
 * text-selection suppression, the double-click reset, the one persist on release — is identical and
 * was worth having once.
 */
export interface ResizeTarget {
  /** Which coordinate the drag reads. */
  axis: "x" | "y";
  /** The current value. */
  read: () => number;
  /** Set it. Called on every pointermove, so it must be cheap and idempotent. */
  write: (value: number) => void;
  /** The value a double-click restores. */
  reset: () => number;
  /** Lower and upper bounds, read fresh because both can depend on the viewport. */
  min: () => number;
  max: () => number;
  /** Target units per pixel of pointer movement, signed: negative grows toward the origin. */
  scale: () => number;
  /** Persist. Called once on release and once on reset — never during the drag. */
  settle: () => void;
}

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
export function setupHandle(handle: HTMLElement, target: ResizeTarget) {
  const { axis } = target;
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
    drag = { start: coord(e), startSize: target.read() };
  });

  handle.addEventListener("pointermove", (e) => {
    if (!drag) {
      return;
    }
    const delta = (coord(e) - drag.start) * target.scale();
    const wanted = drag.startSize + delta;
    const floored = Math.max(target.min(), wanted);
    target.write(Math.min(target.max(), floored));
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
    target.settle();
  });

  handle.addEventListener("dblclick", () => {
    target.write(target.reset());
    target.settle();
  });
}

/** The largest a dock may be dragged to along `axis`. */
function maxDockSize(axis: "x" | "y"): number {
  const viewport = axis === "x" ? window.innerWidth : window.innerHeight;
  return viewport * MAX_RATIO;
}

/** A dock, as a {@link ResizeTarget}. The three rows of {@link HANDLES}, given the shared shape. */
function dockTarget(dock: DockId, axis: "x" | "y", grow: 1 | -1): ResizeTarget {
  return {
    axis,
    max: () => maxDockSize(axis),
    min: () => MIN_SIZE[axis],
    read: () => shell.docks[dock].size,
    reset: () => DOCK_DEFAULT_SIZES[dock],
    scale: () => grow,
    settle: () => persistDocks(),
    write: (value) => setDockSize(dock, Math.round(value)),
  };
}

/** Attach every handle present in the document. Idempotent per element by construction. */
export function mountPanelResize(): void {
  for (const { axis, dock, grow, selector } of HANDLES) {
    const handle = document.querySelector<HTMLElement>(selector);
    if (handle) {
      setupHandle(handle, dockTarget(dock, axis, grow));
    }
  }
}

/* Mounted through the shell's own lifecycle rather than by a bare `mountPanelResize()` at module
   scope. The import-time call read `document` before anything had said the tree existed, which is
   the one part of `registerShellSurface`'s bargain this module was not keeping. */
registerShellSurface({ mount: mountPanelResize, unmount: () => {} });
