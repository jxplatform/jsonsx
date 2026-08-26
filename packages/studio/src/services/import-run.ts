/**
 * Import-run.ts — the live state of a site import, for the transcript to draw.
 *
 * An import takes minutes and reports a line at a time. Those lines used to render into the New
 * Project modal and die with it: a successful import destroyed its own account of what it had done
 * at the moment it handed off. Now the run belongs to a tool call, so the record is keyed by that
 * call's id and the chip and its progress are one thing rather than two.
 *
 * Reactive, so `panels/ai-panel.ts`'s watcher repaints on it through the same rAF coalescer that
 * carries streaming tokens — a crawl emitting a line per page cannot outrun the frame rate.
 *
 * @license MIT
 */

import { reactive } from "../reactivity";

import type { ImportProgressEvent } from "../types";

/**
 * Lines kept per run.
 *
 * A wide crawl emits one per page plus one per asset batch, and every line is also held in the
 * session's localStorage budget once the tool result lands. The tail is what a reader wants; the
 * head is what the summary is for.
 */
export const MAX_LOG_LINES = 200;

export interface ImportRunRecord {
  /** The tool-call id — the join key with the chip the transcript draws. */
  id: string;
  url: string;
  directory: string;
  phase: string;
  message: string;
  current: number | null;
  total: number | null;
  log: ImportProgressEvent[];
  /** Lines the pipeline marked with `⚠`, kept apart so the summary can name them. */
  warnings: string[];
  status: "running" | "done" | "failed" | "stopped";
  error: string;
}

/**
 * One run at a time, because one project is created at a time and `import_site` is `no-project`
 * tiered. Keyed rather than bare so a finished run still renders under its own chip after the next
 * one starts, which is what makes the transcript readable after two attempts.
 */
const runs = reactive<{ records: ImportRunRecord[] }>({ records: [] });

/** Runs kept before the oldest is dropped. Two attempts and a retry is the realistic ceiling. */
const MAX_RUNS = 5;

/** Aborts the in-flight run. Owned here because `ToolRegistry.execute` cannot be handed a signal. */
let controller: AbortController | null = null;

/**
 * Open a run record and return the signal its request should carry.
 *
 * @param {string} id - The tool-call id.
 * @param {{ url: string; directory: string }} init
 * @returns {AbortSignal}
 */
export function beginImportRun(id: string, init: { url: string; directory: string }): AbortSignal {
  controller?.abort();
  controller = new AbortController();
  runs.records.push({
    current: null,
    directory: init.directory,
    error: "",
    id,
    log: [],
    message: "Starting…",
    phase: "start",
    status: "running",
    total: null,
    url: init.url,
    warnings: [],
  });
  if (runs.records.length > MAX_RUNS) {
    runs.records.shift();
  }
  return controller.signal;
}

/**
 * Record one progress line against a run.
 *
 * @param {string} id
 * @param {ImportProgressEvent} evt
 */
export function recordImportProgress(id: string, evt: ImportProgressEvent): void {
  const record = runs.records.find((r) => r.id === id);
  if (!record) {
    return;
  }
  record.phase = evt.phase;
  record.message = evt.message;
  record.current = evt.current ?? null;
  record.total = evt.total ?? null;
  record.log.push(evt);
  if (record.log.length > MAX_LOG_LINES) {
    record.log.shift();
  }
  /* The pipeline reports a soft failure by prefixing its progress line, and `ImportSiteResult`'s
     own `warnings` array does not cross the HTTP boundary — so this is the only place they can be
     recovered from, and the summary needs them to be honest about what was skipped. */
  if (evt.message.startsWith("⚠")) {
    record.warnings.push(evt.message.replace(/^⚠\s*/, ""));
  }
}

/**
 * Close a run.
 *
 * @param {string} id
 * @param {{ status: Exclude<ImportRunRecord["status"], "running">; error?: string }} outcome
 */
export function finishImportRun(
  id: string,
  outcome: { status: Exclude<ImportRunRecord["status"], "running">; error?: string },
): void {
  const record = runs.records.find((r) => r.id === id);
  if (record) {
    record.status = outcome.status;
    record.error = outcome.error ?? "";
  }
  controller = null;
}

/**
 * The record for one tool call, or null. Reactive — read it inside an `effect()` to repaint on it.
 *
 * @param {string} id
 * @returns {ImportRunRecord | null}
 */
export function importRun(id: string): ImportRunRecord | null {
  return runs.records.find((r) => r.id === id) ?? null;
}

/** The run still going, or null. What the panel's watcher tracks. */
export function activeImportRun(): ImportRunRecord | null {
  return runs.records.find((r) => r.status === "running") ?? null;
}

/** Abort the in-flight run. Called from `assistant.stop`, which cannot reach the tool directly. */
export function abortImportRun(): void {
  controller?.abort();
  controller = null;
}

/** Drop every record. For New Chat and for tests. */
export function resetImportRuns(): void {
  abortImportRun();
  runs.records.length = 0;
}
