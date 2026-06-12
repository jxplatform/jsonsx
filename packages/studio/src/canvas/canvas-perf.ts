/**
 * Canvas render instrumentation. Counts full renders vs surgical patches so tests and users can
 * verify that hot-path edits do not rebuild the canvas.
 *
 * Inspect in the browser via `globalThis.__jxCanvasPerf`; enable per-event logging with
 * `localStorage["jx-canvas-debug"] = "1"`.
 */

export interface CanvasPerf {
  /** Full renderCanvas() invocations (whole-canvas orchestration). */
  fullRenders: number;
  /** Individual panel renders (one per breakpoint panel per full render). */
  panelRenders: number;
  /** Doc-effect triggers skipped because the change was consumed by the patcher. */
  skippedFullRenders: number;
  /** Patch ops applied surgically to the live canvas DOM. */
  patchedOps: number;
  /** Isolated subtree re-renders (structural patches). */
  subtreeRenders: number;
  /** Patch batches that escalated to a full render. */
  escalations: number;
  lastEscalationReason: string;
}

export const canvasPerf: CanvasPerf = {
  fullRenders: 0,
  panelRenders: 0,
  skippedFullRenders: 0,
  patchedOps: 0,
  subtreeRenders: 0,
  escalations: 0,
  lastEscalationReason: "",
};

(globalThis as Record<string, unknown>).__jxCanvasPerf = canvasPerf;

function debugEnabled() {
  try {
    return typeof localStorage !== "undefined" && Boolean(localStorage.getItem("jx-canvas-debug"));
  } catch {
    return false;
  }
}

/** Log a canvas perf event when debug mode is on. */
export function perfLog(event: string, detail?: unknown) {
  if (debugEnabled()) {
    console.debug(`[jx-canvas] ${event}`, detail ?? "");
  }
}

/** Record an escalation to full render with its reason. */
export function recordEscalation(reason: string) {
  canvasPerf.escalations += 1;
  canvasPerf.lastEscalationReason = reason;
  perfLog("escalation", reason);
}

/** Reset all counters (for tests). */
export function resetCanvasPerf() {
  canvasPerf.fullRenders = 0;
  canvasPerf.panelRenders = 0;
  canvasPerf.skippedFullRenders = 0;
  canvasPerf.patchedOps = 0;
  canvasPerf.subtreeRenders = 0;
  canvasPerf.escalations = 0;
  canvasPerf.lastEscalationReason = "";
}
