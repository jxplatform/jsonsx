/**
 * Publishing what the author is looking at, so a live preview shows the canvas and not the disk.
 *
 * A live preview composes a page from the project's working TREE, and the tree is what has been
 * saved. The document the author is actually editing lives in a tab's reactive memory and nowhere
 * else, so without this the one thing that makes a live preview worth having — seeing an edit
 * before it is written — would be exactly the thing it could not show.
 *
 * What travels is BYTES, and specifically {@link serializeDocument}'s: the same function `saveFile`
 * writes through, grid controllers, format round-trips, frontmatter and all. That is what makes
 * "what the reader sees" and "what saving would produce" one answer rather than two that drift. A
 * document object would bypass the format layer, and a `.md` page's bytes are not
 * `JSON.stringify(doc)`.
 *
 * **Why an effect and not `transactDoc`.** `transact.ts` has exactly one observer slot and the
 * collab layer owns it. More importantly a transaction hook would MISS three of the most common
 * ways a document changes: a Monaco source commit, a content-entry field edit, and every grid edit
 * route around `transactDoc` entirely. "I edited it in Source and the preview did not change" is
 * the bug this shape avoids.
 *
 * **Why one effect over the whole tab set rather than one per tab.** Reading the map tracks
 * additions, so a tab opened later needs no registration and a tab closed needs no teardown. And
 * the publish is a DIFF against what was last published, which means save, close, discard and undo
 * back to clean all resolve through the same line instead of four hooks that can each be
 * forgotten.
 *
 * **Armed, not always on.** Serializing dirty documents on every edit is not free, and before the
 * author has ever opened a preview there is nothing to publish to. Nothing happens until a preview
 * origin exists.
 *
 * @docs studio/interface
 */

import { effect, effectScope } from "../reactivity";
import { getPlatform, hasPlatform } from "../platform";
import { serializeDocument } from "../files/serialize-document";
import { workspace } from "../workspace/workspace";
import type { Tab } from "../tabs/tab";

/**
 * Trailing debounce on a publish.
 *
 * No leading edge: a leading publish would send the first keystroke of a burst and the last, which
 * is two reloads for one thought. The max wait is what keeps a continuous drag from starving the
 * trailing timer forever.
 */
const PUBLISH_DEBOUNCE_MS = 200;
const PUBLISH_MAX_WAIT_MS = 500;

/** Bytes one document may publish before it is left showing its saved state instead. */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

/**
 * Path to the bytes last published for it, so identical bytes cost nothing.
 *
 * The TEXT rather than a digest of it. An edit that lands back on the same bytes — a character
 * typed and deleted — must not cost the reader a reload, and comparing what was sent is exact where
 * a hash would be a collision away from being wrong for no saving anyone can measure. Memory is
 * bounded by the same per-entry cap the publish is.
 */
const published = new Map<string, string>();

let armed = false;
let scope: ReturnType<typeof effectScope> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let burstStartedAt: number | null = null;
/** The publish in flight, so a flush awaits it rather than racing it. */
let inFlight: Promise<void> | null = null;

/** The documents whose unsaved bytes a preview needs, in the order they were opened. */
function dirtyTabs(): Tab[] {
  const tabs: Tab[] = [];
  for (const tab of workspace.tabs.values()) {
    /* Dirty only. A clean tab's bytes are on disk by definition, and publishing them would create
       a second source of truth for identical content. */
    if (tab.doc.dirty && tab.documentPath) {
      tabs.push(tab);
    }
  }
  return tabs;
}

/**
 * Publish what changed and retract what no longer applies.
 *
 * A diff rather than a stream of events: whatever reason a document has for no longer being unsaved
 * — saved, closed, discarded, undone back to its file — it is simply absent from this pass, and the
 * retraction follows without anywhere else having to remember to ask for it.
 */
async function publish(): Promise<void> {
  /* Not `armed` too: `flushPreviewOverlay` refuses when disarmed and `disarmPreviewOverlay` clears
     the pending timer, so there is no path into here without it. A host with no platform at all is
     real though — `getPlatform()` throws rather than answering null. */
  if (!hasPlatform()) {
    return;
  }
  const platform = getPlatform();
  if (!platform.setPreviewOverlay || !platform.clearPreviewOverlay) {
    return;
  }
  const live = new Set<string>();
  for (const tab of dirtyTabs()) {
    const path = tab.documentPath!.replace(/^\.\//, "");
    let text: string;
    try {
      text = await serializeDocument(tab);
    } catch {
      /* A half-typed document that will not serialize is not a reason to stop previewing the layout
         beside it. Skipped, and the next edit that does serialize publishes it. */
      continue;
    }
    if (text.length > MAX_ENTRY_BYTES) {
      continue;
    }
    live.add(path);
    if (published.get(path) === text) {
      continue;
    }
    published.set(path, text);
    await platform.setPreviewOverlay(path, text);
  }
  for (const path of published.keys()) {
    if (!live.has(path)) {
      published.delete(path);
      await platform.clearPreviewOverlay(path);
    }
  }
}

/** Run a publish, coalescing with any already scheduled. */
function schedule(): void {
  if (!armed) {
    return;
  }
  const now = Date.now();
  burstStartedAt ??= now;
  if (timer) {
    clearTimeout(timer);
  }
  const waited = now - burstStartedAt;
  const delay = Math.max(0, Math.min(PUBLISH_DEBOUNCE_MS, PUBLISH_MAX_WAIT_MS - waited));
  timer = setTimeout(() => {
    timer = null;
    burstStartedAt = null;
    inFlight = publish().finally(() => {
      inFlight = null;
    });
  }, delay);
}

/**
 * Note an edit the reactive effect cannot see.
 *
 * `transactDoc` replaces the document's ROOT REFERENCE on every transaction, and a Monaco source
 * commit assigns a fresh one, so a shallow read catches both. A content-entry field edit writes a
 * key in place on an already-dirty tab, which changes nothing the effect reads. This is the seam
 * for exactly that: an explicit call from the few places that mutate without swapping.
 */
export function notePreviewOverlayEdit(): void {
  schedule();
}

/**
 * Start publishing, because a preview origin now exists to publish to.
 *
 * Idempotent: `View: Open in Browser` calls it on every invocation and only the first does work.
 */
export function armPreviewOverlay(): void {
  if (armed) {
    return;
  }
  armed = true;
  scope = effectScope();
  scope.run(() => {
    effect(() => {
      for (const tab of workspace.tabs.values()) {
        /* Two reads, both shallow. `document` is a fresh reference on every transaction — see
           `transactDoc`, which assigns one specifically so effects re-run — so this costs a
           property read rather than a walk of the document. */
        void tab.doc.dirty;
        void tab.doc.document;
      }
      schedule();
    });
  });
}

/**
 * Stop publishing and forget what was published, without retracting it.
 *
 * Called when the window changes project. The published map is keyed by project-relative path, so
 * carrying it across a switch would let one project's `pages/index.json` be read as the answer for
 * another's — and the backend lets go of the old root's overlay on its own re-root anyway.
 */
export function disarmPreviewOverlay(): void {
  armed = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  burstStartedAt = null;
  scope?.stop();
  scope = null;
  published.clear();
}

/**
 * Publish now and wait for it.
 *
 * Two callers, and both are moments where the debounce is exactly wrong: on the way to opening a
 * browser tab, so the page the author is about to look at already carries their last keystroke; and
 * after a save, so the retraction rides with the write instead of arriving a debounce later and
 * costing a second reload.
 */
export async function flushPreviewOverlay(): Promise<void> {
  if (!armed) {
    return;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
    burstStartedAt = null;
  }
  await inFlight;
  await publish();
}
