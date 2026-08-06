/**
 * Media usage — "which pages use this image?", asked in the shape an author actually wrote.
 *
 * `services/references.ts` already answers "where is this used?" for documents, and its answer is
 * what every destructive confirmation says out loud. Media does not fit through it unmodified, for
 * one reason: **the reference index resolves refs, and a media file's authored ref usually resolves
 * somewhere else.** `public/hero.jpg` is written `/hero.jpg`, which the compiler — and therefore
 * the sweep — resolves to `hero.jpg`. Ask about the file and every reference to it is invisible;
 * the query succeeds, returns zero, and the delete dialog says nothing else refers to it while
 * seven pages break. A confident zero is the one answer a destructive dialog must never invent.
 *
 * So the query is keyed on the AUTHORED ref. {@link authoredRefTargets} enumerates every path a
 * reference to this file resolves to — the file, its served path, its asset-mount path — and this
 * module asks all of them and unions the answers. Everything else is deliberately inherited rather
 * than re-implemented: the same `loadUsages` cache (so a dialog and a panel asking at once are one
 * round trip), the same `invalidateUsages` on any filesystem event, the same `usageWarning`
 * sentence in the confirmation, and the same `usageHeadline` wording on a panel.
 *
 * **A partial answer is `failed`, not a total.** If one lane of the union cannot be counted, the
 * union cannot either — a number assembled from the lanes that worked reads exactly like a complete
 * one, and would understate what a delete breaks. Unknown is the honest answer, and
 * {@link mediaUsageHeadline} says the word.
 *
 * @docs studio/projects/media
 */

import { authoredRefTargets } from "./media-paths";
import { loadUsages, peekUsages, retryUsages, usageHeadline } from "../services/references";
import type { UsageQuery, UsageState } from "../services/references";
import type { ReferenceFile, ReferenceHit, ReferencesResult } from "../types";

/**
 * The queries whose union answers "what uses this media file?".
 *
 * One per authored form. An empty list means there is no question to ask (an empty path), which
 * {@link loadMediaUsages} reports as a failure rather than as "nothing uses it".
 */
export function mediaUsageQueries(path: string): UsageQuery[] {
  return authoredRefTargets(path).map((target) => ({ path: target }));
}

/** Merge one file's hits into the accumulator, summing counts per `(refType, ref)`. */
function mergeFile(into: Map<string, ReferenceFile>, file: ReferenceFile): void {
  const existing = into.get(file.path);
  if (!existing) {
    into.set(file.path, { count: file.count, path: file.path, refs: [...file.refs] });
    return;
  }
  for (const hit of file.refs) {
    const same = existing.refs.find(
      (candidate: ReferenceHit) => candidate.refType === hit.refType && candidate.ref === hit.ref,
    );
    if (same) {
      same.count += hit.count;
    } else {
      existing.refs.push({ ...hit });
    }
  }
  existing.count += file.count;
}

/**
 * One result out of several, for the same file asked about under different names.
 *
 * The lanes cannot double-count: each asks about a DIFFERENT resolved path, and one authored string
 * resolves to exactly one of them. Errors are unioned by path so a document that failed to parse in
 * every lane is reported once, and `path` reports the media file the caller asked about rather than
 * whichever lane happened to be first.
 */
function unionResults(path: string, results: readonly ReferencesResult[]): ReferencesResult {
  const files = new Map<string, ReferenceFile>();
  const errors = new Map<string, { path: string; error: string }>();
  for (const result of results) {
    for (const file of result.files) {
      mergeFile(files, file);
    }
    for (const error of result.errors) {
      if (!errors.has(error.path)) {
        errors.set(error.path, error);
      }
    }
  }
  const merged = [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path));
  return {
    errors: [...errors.values()],
    files: merged,
    filesReferencing: merged.length,
    path,
    refsTotal: merged.reduce((sum, file) => sum + file.count, 0),
    tagName: null,
  };
}

/**
 * Reduce the lanes to one state.
 *
 * Precedence is strictly least-informative-wins, because every step down is a step away from a
 * number the caller could act on: unsupported (the host cannot answer at all) beats failed (it
 * tried and could not) beats pending beats a real union.
 */
function combine(path: string, states: readonly UsageState[]): UsageState {
  if (states.some((state) => state.status === "unsupported")) {
    return { status: "unsupported" };
  }
  const failure = states.find((state) => state.status === "failed");
  if (failure) {
    return failure;
  }
  if (states.some((state) => state.status === "pending")) {
    return { status: "pending" };
  }
  return {
    result: unionResults(
      path,
      states.map((state) => (state as { result: ReferencesResult }).result),
    ),
    status: "ready",
  };
}

/**
 * The answer right now, WITHOUT starting a request — the synchronous read a lit template needs.
 *
 * `null` means at least one lane has never been asked, and the caller decides whether this paint is
 * the one that asks (see {@link loadMediaUsages}).
 */
export function peekMediaUsages(path: string): UsageState | null {
  const queries = mediaUsageQueries(path);
  if (queries.length === 0) {
    return null;
  }
  const states: UsageState[] = [];
  for (const query of queries) {
    const state = peekUsages(query);
    if (state === null) {
      return null;
    }
    states.push(state);
  }
  return combine(path, states);
}

/**
 * Ask every lane and union the answers. Never rejects — a failure is a STATE, because the caller
 * has to render something and "unknown" is the honest something.
 */
export async function loadMediaUsages(path: string): Promise<UsageState> {
  const queries = mediaUsageQueries(path);
  if (queries.length === 0) {
    return { message: "no media file to look for", status: "failed" };
  }
  return combine(path, await Promise.all(queries.map((query) => loadUsages(query))));
}

/** Forget every lane's answer and ask again — the Retry behind a failed media count. */
export async function retryMediaUsages(path: string): Promise<UsageState> {
  const queries = mediaUsageQueries(path);
  if (queries.length === 0) {
    return { message: "no media file to look for", status: "failed" };
  }
  return combine(path, await Promise.all(queries.map((query) => retryUsages(query))));
}

/**
 * The one line a media surface shows beside a file.
 *
 * `null` when the host has no reference index at all — the surface hides the line rather than
 * printing a zero it cannot stand behind. A cold or in-flight query says it is counting, and a
 * failed one says **unknown**, which is a different fact from "unused" and has to read like one.
 */
export function mediaUsageHeadline(state: UsageState | null): string | null {
  if (state === null) {
    return "Counting references…";
  }
  switch (state.status) {
    case "unsupported": {
      return null;
    }
    case "pending": {
      return "Counting references…";
    }
    case "failed": {
      return "Usage unknown";
    }
    default: {
      return usageHeadline(state.result);
    }
  }
}
