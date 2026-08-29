/**
 * Media usage — "which pages use this image?", asked once.
 *
 * `services/references.ts` answers "where is this used?" for every kind of file, and its answer is
 * what every destructive confirmation says out loud. Media needs three things on top of it, and no
 * longer needs the fourth this module was built for.
 *
 * **What it still does.** A media path is normalized before it becomes a query (a leading `./` is
 * not part of a file's identity), an empty path is a FAILURE rather than "nothing uses it", and
 * {@link mediaUsageHeadline} renders the one line a media surface shows beside a file — where a
 * failed query says **unknown**, which is a different fact from "unused" and has to read like one.
 *
 * **What it no longer does, and why that matters.** A media file's authored reference usually
 * resolves somewhere else: `public/hero.jpg` is written `/hero.jpg`, and a content asset is written
 * `./images/hero.png` and republished at its collection's mount. `findReferences` used to resolve a
 * rooted reference against the project root ALONE, so asking it about the file matched none of
 * those and returned a confident zero — the one answer a destructive dialog must never invent. This
 * module's answer was to enumerate every authored spelling of the file and union the results.
 *
 * That was a workaround in the wrong place. A client-side union can make a COUNT come out right and
 * can do nothing at all about the REWRITE, which happens inside the engine — so the engine learned
 * to resolve every lane itself (issue 239/241, `site-architecture.md` §9.3), and the union became a
 * second implementation of a rule that now has one. It is gone: one path in, one query, one answer,
 * and the lanes are the engine's business.
 *
 * @docs studio/projects/media
 */

import { normalizeProjectPath } from "./media-paths";
import { loadUsages, peekUsages, retryUsages, usageHeadline } from "../services/references";
import type { UsageState } from "../services/references";

/** The state a caller gets for a path that names no file. */
const NO_FILE: UsageState = { message: "no media file to look for", status: "failed" };

/**
 * The query for a media file, or null when the path names nothing.
 *
 * Normalizing here rather than at each call site is the whole of what this wrapper adds over
 * `loadUsages`: the file tree, a drop handler and a library tile do not agree on whether a path
 * carries a leading `./`, and two spellings of one file must not become two cache entries.
 */
function mediaQuery(path: string): { path: string } | null {
  const normalized = normalizeProjectPath(path);
  return normalized === "" ? null : { path: normalized };
}

/**
 * The answer right now, WITHOUT starting a request — the synchronous read a lit template needs.
 *
 * `null` means the question has never been asked, and the caller decides whether this paint is the
 * one that asks (see {@link loadMediaUsages}).
 */
export function peekMediaUsages(path: string): UsageState | null {
  const query = mediaQuery(path);
  return query === null ? null : peekUsages(query);
}

/**
 * Ask, or join the ask already in flight. Never rejects — a failure is a STATE, because the caller
 * has to render something and "unknown" is the honest something.
 */
export async function loadMediaUsages(path: string): Promise<UsageState> {
  const query = mediaQuery(path);
  return query === null ? NO_FILE : loadUsages(query);
}

/** Forget the answer and ask again — the Retry behind a failed media count. */
export async function retryMediaUsages(path: string): Promise<UsageState> {
  const query = mediaQuery(path);
  return query === null ? NO_FILE : retryUsages(query);
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
