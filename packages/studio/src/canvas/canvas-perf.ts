/**
 * Canvas render instrumentation. Counts full renders vs surgical patches, and times the render hot
 * path, so tests and profiling runs can verify that ordinary edits neither rebuild the canvas nor
 * blow a frame budget.
 *
 * Counters answer "did this edit escalate?"; timings answer "what did it cost?". Durations are
 * always recorded (a `performance.now()` pair is free at render frequency); `performance.mark` /
 * `performance.measure` entries — the ones that show up on a DevTools flame chart — are emitted
 * only when debug mode is on, so a normal session's timeline stays clean.
 *
 * Inspect in the browser via `globalThis.__jxCanvasPerf`; enable per-event logging and timeline
 * marks with `localStorage["jx-canvas-debug"] = "1"`.
 */

/** Rolling window per span. Bounded so a long session cannot grow the sample arrays. */
const SAMPLE_LIMIT = 128;

/** Span names, so producers and the profiling gate agree on the keys. */
export const SPAN_FULL_RENDER = "fullRender";
export const SPAN_PANEL_RENDER = "panelRender";
export const SPAN_MOUNT_CANVAS = "mountCanvas";
export const SPAN_PATCH_BATCH = "patchBatch";
export const SPAN_SUBTREE_RENDER = "subtreeRender";

export interface SpanStats {
  /** Completed spans recorded under this name. */
  count: number;
  /** Duration of the most recent span, in ms. */
  lastMs: number;
  /** Longest span observed, in ms. */
  maxMs: number;
  /** 95th percentile over the retained window (up to {@link SAMPLE_LIMIT} samples), in ms. */
  p95Ms: number;
  /** Sum of every recorded duration, in ms — divide by `count` for the mean. */
  totalMs: number;
}

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
  /** Duration of the most recent full canvas render, in ms (0 before the first render). */
  lastFullRenderMs: number;
  /** 95th percentile full-render duration over the retained window, in ms. */
  p95FullRenderMs: number;
  /** Per-span timing stats, keyed by span name. */
  timings: Record<string, SpanStats>;
}

export const canvasPerf: CanvasPerf = {
  escalations: 0,
  fullRenders: 0,
  lastEscalationReason: "",
  lastFullRenderMs: 0,
  p95FullRenderMs: 0,
  panelRenders: 0,
  patchedOps: 0,
  skippedFullRenders: 0,
  subtreeRenders: 0,
  timings: {},
};

(globalThis as Record<string, unknown>).__jxCanvasPerf = canvasPerf;

/** Retained duration samples per span, parallel to `canvasPerf.timings`. */
const samples = new Map<string, number[]>();

function debugEnabled() {
  try {
    return typeof localStorage !== "undefined" && Boolean(localStorage.getItem("jx-canvas-debug"));
  } catch {
    return false;
  }
}

/** Monotonic clock, or 0 when the environment has no `performance` (durations then read as 0). */
function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;
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

/** P95 by nearest rank, sorted into a new array so the retained sample order is preserved. */
function percentile95(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((a, b) => a - b);
  // Nearest-rank: index of the smallest value at or above the 95th percentile.
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Record a completed span duration. Exported so a producer that already has a duration (or a test)
 * can feed the same aggregation the `time*` helpers use.
 */
export function recordSpan(name: string, ms: number) {
  const duration = Number.isFinite(ms) && ms > 0 ? ms : 0;
  let window = samples.get(name);
  if (!window) {
    window = [];
    samples.set(name, window);
  }
  window.push(duration);
  if (window.length > SAMPLE_LIMIT) {
    window.shift();
  }
  const previous = canvasPerf.timings[name];
  const stats: SpanStats = {
    count: (previous?.count ?? 0) + 1,
    lastMs: duration,
    maxMs: Math.max(previous?.maxMs ?? 0, duration),
    p95Ms: percentile95(window),
    totalMs: (previous?.totalMs ?? 0) + duration,
  };
  canvasPerf.timings[name] = stats;
  if (name === SPAN_FULL_RENDER) {
    canvasPerf.lastFullRenderMs = stats.lastMs;
    canvasPerf.p95FullRenderMs = stats.p95Ms;
  }
  perfLog(`span:${name}`, `${duration.toFixed(2)}ms`);
}

/**
 * Open a span. The returned function closes it, records the duration, and returns it — call it
 * exactly once, and prefer {@link timeSpan} / {@link timeSpanAsync} when the body is a single
 * expression so an early return cannot skip the close.
 */
export function beginSpan(name: string): () => number {
  const start = now();
  const debug = debugEnabled();
  const startMark = `jx-${name}-start`;
  if (debug) {
    try {
      performance.mark(startMark);
    } catch {
      // Marks are diagnostics; never let them break a render.
    }
  }
  let closed = false;
  return () => {
    if (closed) {
      return canvasPerf.timings[name]?.lastMs ?? 0;
    }
    closed = true;
    const duration = now() - start;
    if (debug) {
      try {
        performance.measure(`jx-${name}`, startMark);
        performance.clearMarks(startMark);
      } catch {
        // Ditto.
      }
    }
    recordSpan(name, duration);
    return duration;
  };
}

/** Time a synchronous body. The span closes even when the body throws. */
export function timeSpan<T>(name: string, body: () => T): T {
  const end = beginSpan(name);
  try {
    return body();
  } finally {
    end();
  }
}

/** Time an async body. The span closes when the promise settles, including on rejection. */
export async function timeSpanAsync<T>(name: string, body: () => Promise<T>): Promise<T> {
  const end = beginSpan(name);
  try {
    return await body();
  } finally {
    end();
  }
}

/** Reset all counters and timings (for tests). */
export function resetCanvasPerf() {
  canvasPerf.fullRenders = 0;
  canvasPerf.panelRenders = 0;
  canvasPerf.skippedFullRenders = 0;
  canvasPerf.patchedOps = 0;
  canvasPerf.subtreeRenders = 0;
  canvasPerf.escalations = 0;
  canvasPerf.lastEscalationReason = "";
  canvasPerf.lastFullRenderMs = 0;
  canvasPerf.p95FullRenderMs = 0;
  canvasPerf.timings = {};
  samples.clear();
}
