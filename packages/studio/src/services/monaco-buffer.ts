/// <reference lib="dom" />
/**
 * The one question every write into a Monaco buffer has to ask: **may I write into this buffer?**
 *
 * Studio has two Monaco surfaces — the source view on the canvas stage (`view.monacoEditor`,
 * mounted by `canvas/canvas-render.ts`) and the function body in the Bottom dock's Logic tab
 * (`view.functionEditor`, mounted by `panels/editors.ts`).
 *
 * **The count in this file is of WRITE SITES — places that put text INTO a buffer** — because a
 * write into a buffer is the only thing that has to ask this module's question. (Writes OUT are
 * counted nowhere: there are two, one per surface, they are the debounced commits, and they ask
 * `bufferIsLive` instead. See the note at the end of this header.) There are four, and none of them
 * can see the keyboard:
 *
 * 1. **the serializer resolving with the file's contents**, at mount — `canvas-render.ts`'s
 *    `mountSourceEditor`;
 * 2. **a repaint pushing the document's text in** — `canvas-render.ts`'s source fast path;
 * 3. **the dock's re-sync**, showing an edit that arrived from somewhere else — `editors.ts`'s
 *    `syncFunctionEditor`;
 * 4. **a code-service round trip landing with a formatted body** — `editors.ts`'s format-on-open.
 *
 * Every one of those writes is computed from a buffer state that may be several keystrokes old by
 * the time it arrives, and `setValue` does not merge — it replaces, and takes the user's unsaved
 * work with it.
 *
 * **And on a co-edited tab there is a FIFTH writer, which is not in that list because it never
 * calls anything here.** `collab/monaco-binding.ts` binds the source model to a shared `Y.Text`, so
 * every peer's keystrokes arrive in the buffer directly and say nothing to anyone. It is also the
 * only writer whose text reaches other people's machines: the binding is two-way, so a local
 * `setValue` over a bound model is a whole-document replace PUBLISHED to every peer. A buffer in
 * that state declares itself with {@link BufferWrites.markShared} and clause 5 refuses every write
 * into it.
 *
 * The rule was already discovered once, in one branch of one fast path:
 *
 * ```js
 * if (!editor.hasTextFocus() && editor.getValue() !== newVal) { … }
 * ```
 *
 * …and it was never given a name, so the other three write sites each invented a different guard.
 * All three asked **identity** — "is this still the same editor object?" — which answers a real
 * question (a retarget must not write A's body into B) and is not the same question. An editor can
 * keep its identity for minutes while its buffer moves on with every keypress. Identity is
 * necessary and never sufficient.
 *
 * {@link bufferMovedOn} is that rule's one home. A write must be dropped when any of these is true
 * — the first four are "the buffer moved on", and the fifth is the one the co-edited surface
 * added:
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
 * 5. **It is not this process's buffer to replace.** The one clause that is not "the buffer moved on"
 *    — it is "the buffer is not yours". A co-edited source buffer is bound to a shared `Y.Text` and
 *    the CRDT is the source of truth for that text while the source lock is held: the structure
 *    tree is DERIVED from it by the source reconciler (`collab/collab-session.ts`'s
 *    `sourceParseNow` parses the shared text back into the tree). A repaint serializing that tree
 *    over the buffer is therefore a rendering of the text asserting itself over the text — and
 *    because the model is bound, it is published to every peer, on every repaint, for every round
 *    trip that is not byte-stable. There is no direction in which a co-edited buffer wants the
 *    document's serialized text, so this fact is set once at bind ({@link BufferWrites.markShared})
 *    and never cleared: a future writer's `markSettled` must not be able to unlock it, which is why
 *    it is its own fact and not a use of clause 3.
 *
 * **Ahead is not the same as unsaved, and the gates that warn about lost work need the narrower
 * fact.** Format-on-open leaves a buffer ahead deliberately and never commits — and since
 * `closeFunctionEditor` writes a MINIFIED body, the pretty-printed buffer differs from the document
 * for as long as the editor is open. Counting THAT as unsaved work would put "you have unsaved
 * changes" in front of every author who merely opened a handler. So a keystroke says
 * {@link BufferWrites.markTyped} — ahead, and the text is the user's own — and the two gates that
 * destroy a tab ({@link commitTabBuffers}'s callers) read {@link BufferWrites.typed}, which is
 * exactly the text a close would take with it.
 *
 * {@link commitBufferWrites} reads the same fact from the other end. A gate asks it BEFORE the
 * destruction, to decide whether to prompt; a disposer asks it AFTER its own flush, when the answer
 * can only be "I have just deleted this" — and is the last thing in a position to say so, because
 * the next line detaches the model and `buffersForTab` stops finding the buffer at all.
 *
 * Writes OUT of a buffer — a debounce reading `getValue()` into the document — ask `bufferIsLive`
 * instead, which is clause 1 alone. Deliberately, and it is the only kind of call site in the
 * codebase entitled to a subset: clauses 2 and 3 describe a buffer that is AHEAD of the document,
 * which is the precondition for committing rather than a reason to refuse, and clause 4 has no
 * meaning for a writer whose whole input is the buffer.
 *
 * @docs studio/logic/code
 */

import { toRaw } from "../reactivity";
import { notify } from "./notify";
import type { Tab } from "../tabs/tab";
import { view } from "../view";
import { allCanvasSurfaces } from "../canvas/surface-registry";

/** The slice of a Monaco editor this module needs. Both of Studio's Monacos satisfy it. */
export interface MonacoBuffer {
  getValue: () => string;
  getModel: () => unknown;
  hasTextFocus: () => boolean;
  /** The debounced work armed over THIS buffer. Installed by {@link bufferWrites}. */
  _writes?: BufferWrites;
  /**
   * The tab this buffer was mounted for — **whose buffer this is**, and both surfaces answer it the
   * same way.
   *
   * Only the dock's editor used to carry it. The source editor named its tab in a closure inside
   * `mountSourceEditor`, which is unreachable from outside — so a caller holding a `Tab` could ask
   * the dock "is this yours?" and had no way at all to ask the source view. Every question about a
   * tab's buffers ({@link commitTabBuffers}, {@link tabBufferUnsaved}) needs both answers, and a
   * question that can only be asked of one of two surfaces is answered wrong half the time.
   */
  _editingTab?: Tab | null;
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
  /**
   * (Re)arm the timer called `key`, replacing whatever was armed under that key.
   *
   * The work may be async — the source view's commit parses through the format host — and
   * {@link BufferWrites.flush} hands that promise back, because a caller that flushes in order to
   * ASK A QUESTION about the result (has this tab unsaved work now?) has to wait for it.
   */
  arm: (key: string, ms: number, run: () => void | Promise<void>) => void;
  /** Cancel every armed timer. The disposer calls this; see {@link cancelBufferWrites}. */
  cancel: () => void;
  /**
   * Run the work armed under `key` NOW, and drop its timer. A no-op when nothing is armed there.
   *
   * The teardown's half of {@link commitBufferWrites}: the debounce is the only thing that carries
   * the last half-second of typing into the document, so a disposer that merely cancels it deletes
   * that typing — silently, because the document is never marked dirty for work it never received.
   *
   * Returns whatever the work returned, so an async commit can be awaited. The disposers ignore it
   * on purpose: they flush precisely because they are about to detach the model, and every commit
   * reads `getValue()` before its own first `await`.
   *
   * **A commit that already fired counts as armed.** The timer drops its key before running, so a
   * flush arriving mid-run would otherwise find nothing and read that as "there was nothing to
   * carry" — which for the source view, whose commit awaits an IPC round trip to the format host,
   * is a window of tens of milliseconds starting the moment the author stops typing. Exactly when
   * they click another tab. The in-flight promise is returned instead, so the caller waits for the
   * answer rather than inventing one.
   */
  flush: (key: string) => void | Promise<void>;
  /** Clause 3, as a fact: the buffer holds text the document has not been given. */
  ahead: () => boolean;
  /** Declare that the buffer just took text which did NOT come from the document. */
  markAhead: () => void;
  /**
   * Clause 3, narrowed to the text a close would DESTROY: the user's own keystrokes, not yet in the
   * document. See the header — `ahead` is also true of format-on-open, whose text nobody loses.
   */
  typed: () => boolean;
  /** Declare a keystroke: {@link BufferWrites.markAhead}, and the text is the user's own. */
  markTyped: () => void;
  /** Declare that buffer and document now hold the same text, whichever way it travelled. */
  markSettled: () => void;
  /** Clause 5, as a fact: this buffer is bound to a shared text that this process does not own. */
  shared: () => boolean;
  /** Declare that the buffer is now bound to a shared text. Permanent — see clause 5. */
  markShared: () => void;
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
  const runs = new Map<string, () => void | Promise<void>>();
  /** Runs that have started and not yet answered. See {@link BufferWrites.flush}. */
  const inFlight = new Map<string, Promise<void>>();
  let isAhead = false;
  let isTyped = false;
  let isShared = false;
  /**
   * Remember a run while it is answering, so a flush arriving mid-run returns its promise rather
   * than the `undefined` that means "nothing was armed". Self-clearing, and it never rejects — the
   * caller inspects the settled state through `typed()`, and a rejection is the commit's own to
   * report.
   */
  function track(key: string, result: void | Promise<void>): void | Promise<void> {
    if (typeof (result as Promise<void> | undefined)?.then !== "function") {
      return result;
    }
    const promise = (result as Promise<void>).finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });
    inFlight.set(key, promise);
    return promise;
  }
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
          /* Discarded deliberately: a timer that fires on its own has no caller to answer to.
             `track` has already put the promise in `inFlight`, which is where a flush arriving
             mid-run collects it — and per the contract above, `run` reports its own failures. */
          void track(key, run());
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
        // Nothing armed — but something may be RUNNING. Its answer is the honest one.
        return inFlight.get(key);
      }
      clearTimeout(timers.get(key));
      timers.delete(key);
      runs.delete(key);
      return track(key, run());
    },
    ahead: () => isAhead,
    markAhead() {
      isAhead = true;
    },
    typed: () => isTyped,
    markTyped() {
      isAhead = true;
      isTyped = true;
    },
    markSettled() {
      isAhead = false;
      isTyped = false;
    },
    shared: () => isShared,
    markShared() {
      isShared = true;
    },
  };
  buffer._writes = writes;
  return writes;
}

/**
 * The two Monaco surfaces, named so a teardown that loses text can say what the author was looking
 * at when it went. Both spellings are this module's, not the caller's, because the sentence has to
 * read the same whichever disposer produced it.
 */
export type BufferSurface = "logic" | "source";

const SURFACE: Record<BufferSurface, { holds: string; reached: string; source: string }> = {
  logic: { holds: "The handler you were typing", reached: "written into", source: "Logic" },
  source: { holds: "The source you were typing", reached: "parsed into", source: "Editor" },
};

/**
 * Say that a teardown destroyed the author's typing, and answer whether it did.
 *
 * Called once per {@link commitBufferWrites}, at the moment the answer is known — synchronously for
 * the dock's body write, and from the promise's continuation for the source view's parse, which
 * cannot answer before the disposer has returned.
 *
 * **A toast rather than a Problem, and the difference is whether anything can be done.** A commit
 * that THREW leaves the text in the buffer, so {@link commitTabBuffers} files a Problem — the
 * author can still go and rescue it, minutes later. Here the buffer is being detached in the same
 * breath: there is nothing left to fix, and a record the app promises to keep until somebody fixes
 * it is the wrong host for a loss that is already final.
 *
 * **It does not ask whether a gate already said this.** A close that destroys the TAB runs
 * `commitTabBuffers` and its dialog first, so an author who chose "Close Without Saving" hears it
 * twice; "is that tab still open?" is `workspace`'s to answer, and `workspace` imports this module.
 * One extra keyed toast confirming a choice the author just made is the cheaper of the two costs.
 *
 * @param {MonacoBuffer} buffer
 * @param {BufferSurface} surface
 * @param {{ error: unknown } | null} failure What the commit threw, BOXED — a commit is free to
 *   throw `undefined`, and "did it throw" must not become "was what it threw interesting".
 * @returns {boolean} True when there was nothing to lose.
 */
function reportDiscarded(
  buffer: MonacoBuffer,
  surface: BufferSurface,
  failure: { error: unknown } | null,
): boolean {
  const writes = buffer._writes;
  if (writes?.typed() !== true) {
    return true;
  }
  const tab = buffer._editingTab ?? null;
  const where = tab?.documentPath ?? "Untitled";
  const { holds, reached, source } = SURFACE[surface];
  notify.warn(`${holds} was discarded — it was never ${reached} "${where}".`, {
    ...(failure ? { detail: describeCommitFailure(failure.error) } : {}),
    key: `buffer-discarded:${surface}:${tab?.id ?? "none"}`,
    source,
    ...(tab?.documentPath ? { path: tab.documentPath } : {}),
  });
  return false;
}

/** What a failed commit is worth showing: the stack when there is one, the value otherwise. */
function describeCommitFailure(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
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
 * **Two more ways out are not a disposer's to fix, and this function cannot reach them.** ⌘W / the
 * tab × and quitting DESTROY THE TAB: `closeTab` deletes it from `workspace.tabs` before anything
 * disposes an editor, so by the time a dock repaint reaches `disposeFunctionEditor` the commit
 * flushed here finds `tabIsLive(tab) === false` and writes nothing. Seven ways out, and the last
 * two are fixed where the decision is made — {@link commitTabBuffers} runs the commit before the
 * gate reads the tab, and {@link tabBufferUnsaved} is what the gate reads when the commit could not
 * land it.
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
 * **AND THE FLUSH IS ALLOWED TO FAIL, which is what the answer is for.** `bodyWriter` returns
 * whether the body reached the document, and it returns `false` whenever the collab gate refuses
 * the write, the tab is gone, or the element the handler hangs off has been deleted; the source
 * view's parse simply declines to settle when the text does not parse. Throwing that answer away
 * here made five exits — dock tab switch, dock collapse, ⌘, opening another Logic target, switching
 * to another tab, plus the source view's model-URI swap and its mode transition — into silent
 * deletions: the buffer holding the only copy is detached on the next line, and with it goes
 * `buffersForTab`'s knowledge that it ever existed, so {@link tabBufferUnsaved} and every gate
 * built on it go back to answering "nothing to lose" about text that has just been destroyed.
 *
 * `closeFunctionEditor` shows the other shape — a refused write keeps the surface, so the text
 * stays on screen and the author can act. **A disposer has no such option.** Every one of its call
 * sites is a repaint or a mode transition that has already replaced the container, and refusing
 * would leave a live Monaco bound to detached DOM, which is the leak this module's teardown exists
 * to prevent. So the disposers all choose the other answer: they cannot keep the text, and they say
 * that it is gone ({@link reportDiscarded}).
 *
 * **The source view's commit answers late, and the report goes with it.** Its parse is an `await`,
 * so the disposer is long finished by the time "did it land" has a value; the promise's
 * continuation reports, and the synchronous return says only what is known at return time. A
 * `false` therefore always means the loss is certain and has been announced.
 *
 * @param {MonacoBuffer | null | undefined} buffer
 * @param {BufferSurface} surface Which editor is being destroyed — names the toast.
 * @returns {boolean} True when the teardown carried everything the author typed, or there was
 *   nothing of theirs to carry. False when it destroyed the author's text, which is reported.
 */
export function commitBufferWrites(
  buffer: MonacoBuffer | null | undefined,
  surface: BufferSurface,
): boolean {
  const writes = buffer?._writes;
  if (!buffer || !writes) {
    return true;
  }
  /* THE FLUSH IS GUARDED AND ITS TWIN'S WAS NOT, which is the whole difference between a failed
     commit and a broken repaint. `bodyWriter`'s event branch resolves `editing.path` in the live
     tree, and a collaborator's delete — or a local undo — makes that path resolve to nothing. The
     throw escaped into `disposeFunctionEditor`, into `syncFunctionEditor`, and out of the dock
     panel's `afterRender`: the repaint aborted mid-way, `cancel()` never ran, `dispose()` never
     ran, and a live 500ms timer was left over an editor whose container lit was about to replace.
     A timer reading `""` off a detached model is the exact defect this module was created to
     prevent, so the teardown below must happen whatever the commit does. */
  let pending: Promise<void> | undefined;
  try {
    // Fire-and-forget on purpose: the disposer is synchronous, and the commit read `getValue()`
    // Before its own first `await`. What is left to await is the write INTO the document, which
    // Does not need this editor to still exist.
    pending = writes.flush(BUFFER_COMMIT) as Promise<void> | undefined;
  } catch (error) {
    writes.cancel();
    return reportDiscarded(buffer, surface, { error });
  }
  writes.cancel();
  if (typeof pending?.then === "function") {
    void pending.then(
      () => reportDiscarded(buffer, surface, null),
      (error: unknown) => reportDiscarded(buffer, surface, { error }),
    );
    return true;
  }
  return reportDiscarded(buffer, surface, null);
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
 * Whether this write must be dropped — the buffer moved on, or was never this write's to make. The
 * five clauses are stated in this module's header.
 *
 * @param {MonacoBuffer} buffer The editor about to be written into.
 * @param {string} [expected] What the caller read out of the buffer before its `await`, when it
 *   made one. Omitted by callers that computed their value from the DOCUMENT rather than from the
 *   buffer, for which clauses 1–3 and 5 are the whole question.
 * @returns {boolean} True when the write must be dropped.
 */
export function bufferMovedOn(buffer: MonacoBuffer, expected?: string): boolean {
  if (
    !bufferIsLive(buffer) ||
    buffer.hasTextFocus() ||
    buffer._writes?.ahead() ||
    buffer._writes?.shared()
  ) {
    return true;
  }
  return expected !== undefined && buffer.getValue() !== expected;
}

/**
 * The Monaco buffers Studio currently has mounted for `tab`, and nothing else.
 *
 * Both surfaces are asked the same question through `_editingTab`, and both are asked clause 1
 * first: a buffer whose model is detached answers `""` to everything and has no work left to hold.
 *
 * **The order is the SOURCE view first and the dock second, and it is load-bearing** — see
 * {@link commitTabBuffers}, which commits them in this order one at a time.
 *
 * @param {Tab} tab
 * @returns {MonacoBuffer[]}
 */
function buffersForTab(tab: Tab): MonacoBuffer[] {
  const raw = toRaw(tab as object);
  /* Every stage's source buffer, plus the dock's one function editor.
     The source view is per-PANE now: two Code panes are two Monaco instances over two documents,
     and a close gate that asked only "the" source editor would have missed whichever one it was
     not holding — which is the same half-answer that let ⌘W close a tab over unprompted typing. */
  const mounted: (MonacoBuffer | null)[] = [
    ...allCanvasSurfaces().map((surface) => surface.monacoEditor as MonacoBuffer | null),
    view.functionEditor,
  ];
  return mounted.filter(
    (buffer): buffer is MonacoBuffer =>
      buffer != null &&
      buffer._editingTab != null &&
      toRaw(buffer._editingTab as object) === raw &&
      bufferIsLive(buffer),
  );
}

/**
 * Carry what `tab`'s buffers are holding into the document, leaving the buffers standing.
 *
 * **The close path is a WRITE before it is a question.** `shouldWarnOnClose` and `hasUnsavedTabs`
 * both read `tab.doc.dirty`, and nothing makes a buffer's armed commit dirty a document it has not
 * reached yet — so typing the last character of a handler and pressing ⌘W closed the tab with no
 * prompt at all and took the last 500ms (dock) / 600ms (source) with it. No disposer can cover
 * this: `closeTab` deletes the tab first, and every commit checks `tabIsLive` precisely so that it
 * will not write into a tab nobody can read. The flush therefore has to happen while the tab is
 * still open, which is here, before the gate.
 *
 * **The two commits run ONE AT A TIME, source first, because they are not independent.** Both
 * surfaces can be open on one tab — the dock's Logic editor is not a canvas mode, so a handler body
 * and the page source are editable side by side — and their two commits write at different
 * granularities. The dock's writes ONE body at `editing.path`; the source view's parses the whole
 * buffer and assigns a whole new `tab.doc.document`. Started together, the dock's synchronous write
 * lands first and the source's post-await assign — computed from buffer text that predates it —
 * replaces the entire tree on top of it, so the body the author just typed is gone with no trace.
 *
 * Reversed, both survive: `bodyWriter` re-reads `tab.doc.document` and re-resolves `editing.path`
 * at call time, so the dock's targeted write applies to whatever tree is there when it runs. The
 * whole-document assign is the destructive direction and therefore goes first; the body write goes
 * last and is the only one that can be the last word. (Two independent timers could already race
 * this either way — but a race that used to be a coin toss is not a licence to make the losing side
 * certain.)
 *
 * **It is always a promise, and callers `await` it.** It used to return `Promise<void> | void` so
 * that a tab with nothing armed closed without spending a microtask. Nothing a user can perceive
 * distinguishes zero microtasks from one; the entire cost was five synchronous assertions in
 * `tests/shortcuts.test.ts`, and the entire price was a three-line `const committing = …; if
 * (committing) await committing;` dance in every present and future caller — which is exactly the
 * shape that let {@link commitTabBuffers}'s one existing caller forget to re-check its tab across
 * the await.
 *
 * Deliberately NOT {@link commitBufferWrites}: that one cancels afterwards, which is right for a
 * disposer and wrong here. The tab may well survive this call — the author can press Cancel on the
 * dialog the flush just caused to appear — and its buffers must still have their lint armed.
 *
 * **AND IT NEVER REJECTS, because its callers are gestures.** `requestClose` awaits this before it
 * asks anything, and a rejection there propagated out of an `async` function nobody awaits: ⌘W did
 * nothing — no prompt, no close, no message, an unhandled rejection in the console. The other two
 * callers (`openTab`'s preview replacement, the project switch) do not even await it, so a
 * rejection is invisible by construction. A commit is also not all-or-nothing: the source view's
 * commit and the dock's write to DIFFERENT places, so the first one throwing must not cost the
 * second its turn — which is why the guard is per buffer rather than around the loop.
 *
 * What a failed commit leaves behind is the honest state, not a lost one: `markSettled` never ran,
 * so the buffer is still `typed()`, {@link tabBufferUnsaved} still answers yes, and the gate above
 * the close still prompts. This function's remaining job is to make sure somebody is told, which is
 * a problem rather than a toast: an author who reads it minutes later still needs to know that one
 * document's editor holds text the file does not.
 *
 * @param {Tab} tab
 * @returns {Promise<void>} Resolves when every commit this flush started has finished or failed.
 */
export async function commitTabBuffers(tab: Tab): Promise<void> {
  for (const buffer of buffersForTab(tab)) {
    /* Clause 1, RE-ASKED, because the list was taken before the previous commit's await. Assigning
       a new document repaints the dock, and a repaint can dispose the function editor — whose
       `getValue()` then answers `""`. Committing that is the deletion this module exists to
       prevent. (The ordinary teardown already flushed and cancelled, so this usually finds nothing
       armed; "usually" is not a guard.) */
    if (!bufferIsLive(buffer)) {
      continue;
    }
    try {
      await buffer._writes?.flush(BUFFER_COMMIT);
    } catch (error) {
      notify.error(
        `Could not save the editor's contents into "${tab.documentPath ?? "Untitled"}".`,
        {
          detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
          key: `buffer-commit:${tab.id}`,
          source: "Editor",
          ...(tab.documentPath ? { path: tab.documentPath } : {}),
        },
      );
    }
  }
}

/**
 * Whether a buffer of `tab`'s holds the user's own typing that the document has not been given.
 *
 * What the unsaved-work gates ask AFTER {@link commitTabBuffers}, because a commit is allowed to
 * fail to land: unparseable source deliberately leaves the buffer ahead rather than resyncing over
 * a half-typed heading, and that text exists nowhere but the buffer. `typed()` rather than
 * `ahead()` — the header says why counting format-on-open as unsaved work would warn every author
 * who merely opened a handler.
 *
 * @param {Tab} tab
 * @returns {boolean}
 */
export function tabBufferUnsaved(tab: Tab): boolean {
  return buffersForTab(tab).some((buffer) => buffer._writes?.typed() === true);
}
