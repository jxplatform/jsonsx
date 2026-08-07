/// <reference lib="dom" />
/**
 * The one question every write into a Monaco buffer has to ask: **has the buffer moved on?**
 *
 * Studio has two Monaco surfaces — the source view on the canvas stage (`view.monacoEditor`,
 * mounted by `canvas/canvas-render.ts`) and the function body in the Bottom dock's Logic tab
 * (`view.functionEditor`, mounted by `panels/editors.ts`). Both are written into from places that
 * cannot see the keyboard: a repaint pushing the document's text in, a code-service round trip
 * landing with a formatted body, a serializer resolving with the file's contents. Every one of
 * those writes is computed from a buffer state that may be several keystrokes old by the time it
 * arrives, and `setValue` does not merge — it replaces, and takes the user's unsaved work with it.
 *
 * The rule was already discovered once, in one branch of one fast path:
 *
 * ```js
 * if (!editor.hasTextFocus() && editor.getValue() !== newVal) { … }
 * ```
 *
 * …and it was never given a name, so the other four write sites each invented a different guard.
 * All four asked **identity** — "is this still the same editor object?" — which answers a real
 * question (a retarget must not write A's body into B) and is not the same question. An editor can
 * keep its identity for minutes while its buffer moves on with every keypress. Identity is
 * necessary and never sufficient.
 *
 * {@link bufferMovedOn} is that rule's one home. A buffer has moved on when any of these is true:
 *
 * 1. **It is gone.** `dispose()` detaches the model, and `CodeEditorWidget.getValue()` opens with `if
 *    (!this._modelData) return "";` — so a dead editor answers the empty string and a write into it
 *    lands nowhere.
 * 2. **The user is in it.** `hasTextFocus()` means their next keystroke is newer than your value.
 * 3. **It holds text the document has not been given.** A repaint that resolves a buffer/document
 *    difference in the document's favour discards whatever put the difference there.
 *
 *    This clause was first written as `pending()` — "a commit is armed" — which is the same thing for
 *    a KEYSTROKE and a different thing for every other write. A programmatic write sets
 *    `_ignoreNextChange`, so the change handler returns before it can arm anything: the buffer is
 *    ahead with nothing pending, and a timer-shaped clause reported "settled". That is exactly the
 *    state format-on-open leaves — it pretty-prints into the buffer and deliberately never commits —
 *    so the next repaint reverted it, and **"Format on open" visibly un-formatted itself** within
 *    seconds of every open, now that the dock repaints on the Problems badge, on Activity and on a
 *    30-second git poll.
 *
 *    So it is a FACT the buffer carries ({@link BufferWrites.ahead}), not an inference from a timer.
 *    Whoever writes into a buffer says which side the text came from: text that did not come from the
 *    document marks it {@link BufferWrites.markAhead}, and the document taking the buffer's text — or
 *    the buffer taking the document's — marks it {@link BufferWrites.markSettled}. A keystroke marks
 *    ahead and arms its commit; the commit marks settled.
 * 4. **It is not what the write was computed from.** A caller that read the buffer before an `await`
 *    passes what it read as `expected`; a mismatch means the round trip lost the race.
 *
 * Writes OUT of a buffer — a debounce reading `getValue()` into the document — ask `bufferIsLive`
 * instead, which is clause 1 alone. Deliberately, and it is the only kind of call site in the
 * codebase entitled to a subset: clauses 2 and 3 describe a buffer that is AHEAD of the document,
 * which is the precondition for committing rather than a reason to refuse, and clause 4 has no
 * meaning for a writer whose whole input is the buffer.
 *
 * @docs studio/logic/code
 */

/** The slice of a Monaco editor this module needs. Both of Studio's Monacos satisfy it. */
export interface MonacoBuffer {
  getValue: () => string;
  getModel: () => unknown;
  hasTextFocus: () => boolean;
  /** The debounced work armed over THIS buffer. Installed by {@link bufferWrites}. */
  _writes?: BufferWrites;
}

/**
 * The debounced work armed over one buffer, with that buffer's exact lifetime.
 *
 * It hangs off the editor rather than off `view` or a module variable because those two spellings
 * are what the two surfaces had: the dock's canceller was an editor property, the canvas's timer
 * was a closure variable inside `mountSourceEditor` that nothing outside could reach — so of the
 * two, only one teardown could cancel, and the canvas's three disposal sites cancelled nothing at
 * all. Whoever disposes an editor now has its canceller in their hand by construction.
 */
export interface BufferWrites {
  /** (Re)arm the timer called `key`, replacing whatever was armed under that key. */
  arm: (key: string, ms: number, run: () => void) => void;
  /** Cancel every armed timer. The disposer calls this; see {@link cancelBufferWrites}. */
  cancel: () => void;
  /**
   * Run the work armed under `key` NOW, and drop its timer. A no-op when nothing is armed there.
   *
   * The teardown's half of {@link commitBufferWrites}: the debounce is the only thing that carries
   * the last half-second of typing into the document, so a disposer that merely cancels it deletes
   * that typing — silently, because the document is never marked dirty for work it never received.
   */
  flush: (key: string) => void;
  /** Clause 3, as a fact: the buffer holds text the document has not been given. */
  ahead: () => boolean;
  /** Declare that the buffer just took text which did NOT come from the document. */
  markAhead: () => void;
  /** Declare that buffer and document now hold the same text, whichever way it travelled. */
  markSettled: () => void;
}

/**
 * The key both surfaces arm their document-commit under.
 *
 * A shared constant rather than each surface's own string, because {@link commitBufferWrites} has to
 * be able to flush THE COMMIT and only the commit. A buffer also arms a lint (`"lint"`), and firing
 * a lint request at a buffer that is being disposed is work for an editor that will not exist when
 * the answer arrives.
 */
export const BUFFER_COMMIT = "commit";

/**
 * Install (and return) the debounce holder for `buffer`.
 *
 * Called once per mount, right after the editor is created, so that the very first keystroke arms
 * its commit through a canceller the teardown can already see.
 *
 * @param {MonacoBuffer} buffer The freshly created editor.
 * @returns {BufferWrites}
 */
export function bufferWrites(buffer: MonacoBuffer): BufferWrites {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const runs = new Map<string, () => void>();
  let isAhead = false;
  const writes: BufferWrites = {
    arm(key, ms, run) {
      clearTimeout(timers.get(key));
      runs.set(key, run);
      timers.set(
        key,
        setTimeout(() => {
          // Dropped BEFORE the body runs: a callback that re-arms its own key must not have that
          // Arm cleared out from under it, and a flush of a key already executing must find nothing.
          timers.delete(key);
          runs.delete(key);
          run();
        }, ms),
      );
    },
    cancel() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      runs.clear();
    },
    flush(key) {
      const run = runs.get(key);
      if (!run) {
        return;
      }
      clearTimeout(timers.get(key));
      timers.delete(key);
      runs.delete(key);
      run();
    },
    ahead: () => isAhead,
    markAhead() {
      isAhead = true;
    },
    markSettled() {
      isAhead = false;
    },
  };
  buffer._writes = writes;
  return writes;
}

/**
 * Carry what the buffer is holding into the document, then drop everything armed over it.
 *
 * **The teardown's obligation, and it is two obligations rather than one.** A disposer that only
 * cancels stops a dead buffer from writing `""` over a handler — the round-3 defect — by throwing
 * away the last half-second of typing instead. That is still lost work, and it is worse in one
 * respect: `doc.dirty` stays `false`, so nothing on screen says anything went missing. Five ways
 * out of the code surface lost an edit that way (switch dock tab, open another target, open a
 * formula through `openLogicTarget`, collapse the dock, switch to a tab whose target string
 * matches), and each measured as "the pre-typing body, quietly".
 *
 * The order is the whole point: flush WHILE THE BUFFER IS STILL ALIVE, then cancel, then dispose.
 * Reversed, or deferred by so much as a microtask, the flush reads the empty string off a detached
 * model and writes that — which is the defect this replaces, not a fix for it. The flushed callback
 * must therefore read `getValue()` before its own first `await`, which both surfaces' commits do.
 *
 * Cancel-without-flush ({@link cancelBufferWrites}) stays correct in exactly one place, and only
 * because the commit has already happened by other means: `closeFunctionEditor` reads the buffer
 * itself and writes a MINIFIED body through the same writer, so the armed commit holds nothing but
 * a raw copy of what was just written, and replaying it afterwards would undo the minify. Every
 * other disposal path — `disposeFunctionEditor`, `disposeSourceEditor` and therefore
 * `resetCanvasView`, the model-URI swap and the mode transition — flushes.
 *
 * @param {MonacoBuffer | null | undefined} buffer
 */
export function commitBufferWrites(buffer: MonacoBuffer | null | undefined): void {
  const writes = buffer?._writes;
  if (!writes) {
    return;
  }
  writes.flush(BUFFER_COMMIT);
  writes.cancel();
}

/**
 * Cancel the debounced work armed over `buffer`. Safe on null, and on a buffer that never armed any
 * — which is why every disposal site can call it unconditionally.
 *
 * **This is not housekeeping, it is the correctness of the teardown.** A surviving timer reads
 * `getValue()` off a disposed editor, gets `""`, and writes that into the document: for the dock it
 * deletes a handler half a second after the surface closed, and for the source view it replaces a
 * whole page body with an empty parse 600ms after the user left Code view.
 *
 * @param {MonacoBuffer | null | undefined} buffer
 */
export function cancelBufferWrites(buffer: MonacoBuffer | null | undefined): void {
  buffer?._writes?.cancel();
}

/**
 * Whether `buffer` still has a model — i.e. whether there is a buffer at all.
 *
 * The question a write OUT of the buffer asks. `dispose()` runs `_detachModel()`, so this is false
 * for a disposed editor and its `getValue()` is the empty string rather than the text it held.
 *
 * @param {MonacoBuffer | null | undefined} buffer
 * @returns {boolean}
 */
export function bufferIsLive(buffer: MonacoBuffer | null | undefined): boolean {
  return Boolean(buffer?.getModel());
}

/**
 * Whether the buffer has moved on since the write now being attempted was computed. The four
 * clauses are stated in this module's header.
 *
 * @param {MonacoBuffer} buffer The editor about to be written into.
 * @param {string} [expected] What the caller read out of the buffer before its `await`, when it
 *   made one. Omitted by callers that computed their value from the DOCUMENT rather than from the
 *   buffer, for which clauses 1–3 are the whole question.
 * @returns {boolean} True when the write must be dropped.
 */
export function bufferMovedOn(buffer: MonacoBuffer, expected?: string): boolean {
  if (!bufferIsLive(buffer) || buffer.hasTextFocus() || buffer._writes?.ahead()) {
    return true;
  }
  return expected !== undefined && buffer.getValue() !== expected;
}
