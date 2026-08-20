/**
 * The one rule both Monaco surfaces owe (`services/monaco-buffer.ts`).
 *
 * Studio has two Monaco editors, mounted by different modules and torn down by different events,
 * and each of the FOUR writes INTO them had grown its own guard. (Four is the count of write sites,
 * which is the module header's rule and the only count kept anywhere: writes OUT are the two
 * debounced commits, and they ask `bufferIsLive` instead.) All four asked identity — "is this still
 * the same editor object?" — which is a different question from "has the buffer moved on?", and is
 * passed by a repaint into a live editor mid-word. A co-edited tab has a FIFTH writer (the collab
 * Monaco binding, writing peers' keystrokes into the model) which asked nothing at all, because it
 * does not know this module exists.
 *
 * These tests pin the five clauses of the shared predicate in isolation, plus the two questions a
 * TAB asks of its buffers when it is about to be destroyed; `tests/editors.test.ts`,
 * `tests/canvas-render.test.ts`, `tests/tab-strip.test.ts` and `tests/studio-shell.test.ts` pin
 * what each call site does with the answer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  BUFFER_COMMIT,
  bufferIsLive,
  bufferMovedOn,
  bufferWrites,
  cancelBufferWrites,
  commitBufferWrites,
  commitTabBuffers,
  tabBufferUnsaved,
} from "../src/services/monaco-buffer";
import type { MonacoBuffer } from "../src/services/monaco-buffer";
import { view } from "../src/view";
import { problems, resetNotifications, toasts } from "../src/services/notify";
import type { Tab } from "../src/tabs/tab";
import { surfaceForPane } from "../src/canvas/surface-registry";

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A Monaco stand-in with the three methods the rule reads, and honest post-dispose answers. */
function fakeBuffer(value = "hello"): MonacoBuffer & {
  focused: boolean;
  dispose: () => void;
} {
  let model: object | null = { id: "model" };
  return {
    dispose() {
      model = null;
    },
    focused: false,
    getModel: () => model,
    // Mirrors `CodeEditorWidget.getValue()`: `if (!this._modelData) return "";`
    getValue: () => (model ? value : ""),
    hasTextFocus() {
      return this.focused as boolean;
    },
  };
}

describe("bufferIsLive", () => {
  test("is false for nothing, and for an editor whose model was detached", () => {
    const nothing = undefined as MonacoBuffer | null | undefined;
    expect(bufferIsLive(null)).toBe(false);
    expect(bufferIsLive(nothing)).toBe(false);
    const buffer = fakeBuffer();
    expect(bufferIsLive(buffer)).toBe(true);
    buffer.dispose();
    expect(bufferIsLive(buffer)).toBe(false);
  });
});

describe("bufferMovedOn", () => {
  test("a settled buffer holding what the write was computed from accepts it", () => {
    const buffer = fakeBuffer("return 1;");
    expect(bufferMovedOn(buffer)).toBe(false);
    expect(bufferMovedOn(buffer, "return 1;")).toBe(false);
  });

  test("clause 1 — a disposed editor has no buffer to write into", () => {
    const buffer = fakeBuffer();
    buffer.dispose();
    expect(bufferMovedOn(buffer)).toBe(true);
  });

  test("clause 2 — the user's keystrokes are newer than any value you computed", () => {
    const buffer = fakeBuffer();
    buffer.focused = true;
    expect(bufferMovedOn(buffer)).toBe(true);
  });

  /**
   * Clause 3 is a FACT the buffer carries, not an inference from a timer — and the difference is
   * every programmatic write.
   *
   * Spelled as `pending()` it meant "a keystroke is inside its debounce window", which is a
   * different sentence from the one the header made. Format-on-open writes pretty-printed code into
   * the buffer with `_ignoreNextChange` set, so the change handler returns before anything is
   * armed: the buffer is ahead of the document with nothing pending, the old clause answered
   * "settled", and the next repaint reverted the formatting in front of the author.
   */
  test("clause 3 — the buffer holds text the document has not been given", () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    expect(bufferMovedOn(buffer)).toBe(false);

    // A keystroke: ahead, and armed. Both, and they are two statements.
    writes.markAhead();
    writes.arm(BUFFER_COMMIT, 500, () => {});
    expect(bufferMovedOn(buffer)).toBe(true);

    // Cancelling the timer does NOT settle the buffer. Nothing carried its text into the document,
    // So a repaint that overwrote it now would still be discarding the same edit.
    writes.cancel();
    expect(bufferMovedOn(buffer)).toBe(true);

    writes.markSettled();
    expect(bufferMovedOn(buffer)).toBe(false);
  });

  test("clause 3 — a programmatic write with nothing armed still counts as ahead", () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    // What format-on-open leaves behind: no timer, no focus, a live model — and text the document
    // Has never seen. The timer-shaped clause called this settled.
    writes.markAhead();
    expect(writes.ahead()).toBe(true);
    expect(bufferMovedOn(buffer)).toBe(true);
  });

  test("clause 4 — the round trip lost the race to the text it was computed from", () => {
    const buffer = fakeBuffer("typed since");
    expect(bufferMovedOn(buffer, "what I sent")).toBe(true);
  });

  /**
   * Clause 5 is the one that is not "the buffer moved on" — it is "the buffer is not yours".
   *
   * A co-edited source buffer is bound to a shared `Y.Text`: peers' keystrokes arrive in it saying
   * nothing, and anything written into it is PUBLISHED to every peer. Clause 3 could not stand in
   * for this. `ahead` is cleared by any `markSettled`, and a fact that a future writer can switch
   * off is not a lock; the CRDT owns this text for the whole life of the binding.
   */
  test("clause 5 — a buffer bound to a shared text refuses every write, permanently", () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    expect(bufferMovedOn(buffer)).toBe(false);

    writes.markShared();
    expect(writes.shared()).toBe(true);
    expect(bufferMovedOn(buffer)).toBe(true);
    // Even for a caller holding exactly the text the buffer holds, and even after a settle.
    expect(bufferMovedOn(buffer, "hello")).toBe(true);
    writes.markSettled();
    expect(bufferMovedOn(buffer)).toBe(true);
  });
});

/**
 * AHEAD IS NOT UNSAVED, and the gates that destroy a tab need the narrower fact.
 *
 * Both are "the buffer holds text the document has not been given", and only one of them is work a
 * close would destroy. Format-on-open pretty-prints into the buffer and deliberately never commits;
 * since `closeFunctionEditor` writes a MINIFIED body, that difference lasts as long as the editor
 * is open. Reading `ahead()` at the quit gate would therefore prompt "you have unsaved changes" at
 * every author who merely opened a handler and typed nothing.
 */
describe("typed", () => {
  test("a keystroke is both ahead and typed; format-on-open is only ahead", () => {
    const formatted = bufferWrites(fakeBuffer());
    formatted.markAhead();
    expect(formatted.ahead()).toBe(true);
    expect(formatted.typed()).toBe(false);

    const keyed = bufferWrites(fakeBuffer());
    keyed.markTyped();
    expect(keyed.ahead()).toBe(true);
    expect(keyed.typed()).toBe(true);
  });

  test("the commit settles both — the document now holds what the buffer holds", () => {
    const writes = bufferWrites(fakeBuffer());
    writes.markTyped();
    writes.markSettled();
    expect(writes.ahead()).toBe(false);
    expect(writes.typed()).toBe(false);
  });

  test("a commit that could NOT land leaves the typing declared", () => {
    // What the source view does with unparseable text: it keeps the buffer rather than resyncing
    // Over a half-typed heading, and deliberately does not settle. That text exists nowhere else.
    const writes = bufferWrites(fakeBuffer());
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 500, () => {
      /* The parse throws, so nothing settles. */
    });
    void writes.flush(BUFFER_COMMIT);
    expect(writes.typed()).toBe(true);
  });
});

describe("bufferWrites", () => {
  test("arming the same key replaces the previous timer rather than adding one", async () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    const ran: string[] = [];
    writes.arm(BUFFER_COMMIT, 10, () => {
      ran.push("first");
    });
    writes.arm(BUFFER_COMMIT, 10, () => {
      ran.push("second");
    });
    await sleep(40);
    expect(ran).toEqual(["second"]);
    // A fired timer leaves nothing to flush — the key is dropped before the body runs, so a
    // Teardown arriving during the commit cannot run it a second time.
    void writes.flush(BUFFER_COMMIT);
    expect(ran).toEqual(["second"]);
  });

  test("different keys are independent, and cancel drops all of them", async () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    const ran: string[] = [];
    writes.arm(BUFFER_COMMIT, 10, () => {
      ran.push("commit");
    });
    writes.arm("lint", 15, () => {
      ran.push("lint");
    });
    writes.cancel();
    await sleep(40);
    expect(ran).toEqual([]);
    // Cancelled means gone, not merely un-timed: a later flush has nothing to find.
    void writes.flush(BUFFER_COMMIT);
    expect(ran).toEqual([]);
  });

  test("it is installed on the buffer, so the disposer holds the canceller", async () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    expect(buffer._writes).toBe(writes);
    const ran: string[] = [];
    writes.arm(BUFFER_COMMIT, 10, () => {
      ran.push("commit");
    });
    cancelBufferWrites(buffer);
    await sleep(40);
    expect(ran).toEqual([]);
  });

  test("flush runs the armed work now, and only under the key asked for", async () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    const ran: string[] = [];
    writes.arm(BUFFER_COMMIT, 500, () => {
      ran.push("commit");
    });
    writes.arm("lint", 750, () => {
      ran.push("lint");
    });

    void writes.flush(BUFFER_COMMIT);
    expect(ran).toEqual(["commit"]);

    // And the timer it just ran is gone, so it does not also fire on its own schedule.
    await sleep(40);
    expect(ran).toEqual(["commit"]);
    void writes.flush("nothing-armed-here");
    expect(ran).toEqual(["commit"]);
  });
});

/**
 * The teardown's obligation, and the reason it is two calls rather than one.
 *
 * Round 3 let a surviving timer read `""` off a disposed editor and write it into the document.
 * Round 4 cancelled instead — which stops the corruption by discarding the last half-second of
 * typing, and does it SILENTLY, because a document that never received the edit is never marked
 * dirty. The property is neither "nothing is written" nor "something is written": it is that the
 * edit survives the teardown and the dead buffer is never read.
 */
describe("commitBufferWrites", () => {
  test("flushes the commit while the buffer is alive, then drops everything else", () => {
    const buffer = fakeBuffer("return 42;");
    const writes = bufferWrites(buffer);
    const written: string[] = [];
    const linted: string[] = [];
    writes.arm(BUFFER_COMMIT, 500, () => {
      written.push(buffer.getValue());
    });
    writes.arm("lint", 750, () => {
      linted.push(buffer.getValue());
    });

    commitBufferWrites(buffer, "logic");
    buffer.dispose();

    // The commit ran against the LIVE buffer — `"return 42;"`, not the `""` a detached model answers.
    expect(written).toEqual(["return 42;"]);
    // The lint did not. A round trip started for an editor being disposed answers to nobody.
    expect(linted).toEqual([]);
    // And nothing is left armed to fire afterwards.
    void writes.flush(BUFFER_COMMIT);
    expect(written).toEqual(["return 42;"]);
  });

  test("is safe on nothing, and on a buffer that never armed a commit", () => {
    const nothing = undefined as MonacoBuffer | null | undefined;
    expect(commitBufferWrites(null, "logic")).toBe(true);
    expect(commitBufferWrites(nothing, "logic")).toBe(true);
    expect(commitBufferWrites(fakeBuffer(), "source")).toBe(true);
    const buffer = fakeBuffer();
    bufferWrites(buffer);
    expect(commitBufferWrites(buffer, "logic")).toBe(true);
  });

  /**
   * A DISPOSER THAT DESTROYS THE AUTHOR'S TEXT HAS TO SAY SO.
   *
   * `bodyWriter` answers whether the body reached the document, and the answer is `false` whenever
   * the collab freeze refuses the write, the tab is gone, or the element the handler hangs off has
   * been deleted; the source view's parse simply declines to settle on text that does not parse.
   * Throwing that answer away turned five exits — dock tab switch, dock collapse, ⌘, opening
   * another Logic target, switching to another tab — into silent deletions, and the last line of
   * each is what makes them unrecoverable: once the model is detached `buffersForTab` no longer
   * finds the buffer, so `tabBufferUnsaved` and every gate built on it go back to reporting
   * "nothing to lose" about text that has just been destroyed.
   */
  test("a refused commit is reported, and the answer says the text is gone", () => {
    resetNotifications();
    const buffer = fakeBuffer("state.count += 1;") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    buffer._editingTab = { documentPath: "pages/index.md", id: "a" } as unknown as Tab;
    const writes = bufferWrites(buffer);
    writes.markTyped();
    // The freeze: `transactDoc` returns false, so `bodyWriter` never settles the buffer.
    writes.arm(BUFFER_COMMIT, 500, () => {});

    expect(commitBufferWrites(buffer, "logic")).toBe(false);

    const toast = toasts.find((t) => t.key === "buffer-discarded:logic:a");
    expect(toast?.message).toBe(
      'The handler you were typing was discarded — it was never written into "pages/index.md".',
    );
    expect(toast?.path).toBe("pages/index.md");
    // A toast, not a Problem: the buffer is detached on the caller's next line, so there is
    // Nothing left for anybody to go and fix.
    expect(toast?.tier).toBe("toast");
    expect(problems.find((p) => p.key === "buffer-discarded:logic:a")).toBeUndefined();
  });

  test("a commit that landed says nothing at all", () => {
    resetNotifications();
    const landed: string[] = [];
    const buffer = mountedBuffer(tabA, "return 1;", landed);
    expect(commitBufferWrites(buffer, "logic")).toBe(true);
    expect(landed).toEqual(["return 1;"]);
    expect(toasts.filter((t) => t.key?.startsWith("buffer-discarded:"))).toEqual([]);
  });

  test("and neither does a buffer that is merely ahead — format-on-open loses nobody anything", () => {
    resetNotifications();
    const buffer = fakeBuffer("return 1;\n");
    bufferWrites(buffer).markAhead();
    expect(commitBufferWrites(buffer, "logic")).toBe(true);
    expect(toasts.filter((t) => t.key?.startsWith("buffer-discarded:"))).toEqual([]);
  });

  /* The source view's commit parses through the format host, so "did it land" has no value until
     long after the synchronous disposer has returned. The report goes with the answer. */
  test("an async parse that fails reports when it fails, not when the disposer returns", async () => {
    resetNotifications();
    const buffer = fakeBuffer("# half a headin") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    buffer._editingTab = { documentPath: "pages/about.md", id: "s" } as unknown as Tab;
    const writes = bufferWrites(buffer);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 600, async () => {
      await sleep(5);
      // Unparseable: the commit keeps the buffer rather than resyncing, and never settles.
    });

    // Nothing is known yet, so nothing is claimed.
    expect(commitBufferWrites(buffer, "source")).toBe(true);
    expect(toasts.filter((t) => t.key?.startsWith("buffer-discarded:"))).toEqual([]);

    await sleep(30);
    const toast = toasts.find((t) => t.key === "buffer-discarded:source:s");
    expect(toast?.message).toBe(
      'The source you were typing was discarded — it was never parsed into "pages/about.md".',
    );
  });

  /*
   * THE TIMER MAY HAVE FIRED ALREADY, AND THAT IS NOT THE SAME AS NOTHING BEING ARMED.
   *
   * `arm` drops its key before running, so a flush arriving mid-run used to find nothing and read
   * that as "there was nothing of the author's to carry" — then announce a discard for text that
   * was, at that moment, being written. For the source view the window is the format host's IPC
   * round trip: tens of milliseconds beginning the moment the author STOPS typing, which is
   * exactly when they click another tab.
   */
  test("a commit already in flight is waited for, not reported as a discard", async () => {
    resetNotifications();
    const landed: string[] = [];
    const buffer = fakeBuffer("# the page") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    buffer._editingTab = tabA;
    const writes = bufferWrites(buffer);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 1, async () => {
      const text = buffer.getValue();
      await sleep(20);
      landed.push(text);
      writes.markSettled();
    });

    // Let the 1ms timer fire. The run is now executing and its key is already gone.
    await sleep(10);
    expect(writes.typed()).toBe(true);

    expect(commitBufferWrites(buffer, "source")).toBe(true);
    expect(toasts.filter((t) => t.key?.startsWith("buffer-discarded:"))).toEqual([]);

    await sleep(40);
    // It landed, and no toast ever claimed otherwise.
    expect(landed).toEqual(["# the page"]);
    expect(writes.typed()).toBe(false);
    expect(toasts.filter((t) => t.key?.startsWith("buffer-discarded:"))).toEqual([]);
  });

  test("an async parse that lands says nothing", async () => {
    resetNotifications();
    const landed: string[] = [];
    const buffer = fakeBuffer("# the page") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    buffer._editingTab = tabA;
    const writes = bufferWrites(buffer);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 600, async () => {
      const text = buffer.getValue();
      await sleep(5);
      landed.push(text);
      writes.markSettled();
    });

    expect(commitBufferWrites(buffer, "source")).toBe(true);
    await sleep(30);
    expect(landed).toEqual(["# the page"]);
    expect(toasts.filter((t) => t.key?.startsWith("buffer-discarded:"))).toEqual([]);
  });

  /**
   * A COMMIT THAT THROWS MUST NOT ESCAPE, and its twin has been guarded since the round before.
   *
   * `bodyWriter`'s event branch resolves `editing.path` in the live tree, and a collaborator's
   * delete — or a local undo — makes it resolve to nothing. The throw escaped `commitBufferWrites`,
   * `disposeFunctionEditor` and `syncFunctionEditor`, which is the dock panel's `afterRender`: the
   * repaint aborted mid-way, `cancel()` never ran, `dispose()` never ran, and a live 500ms timer
   * was left over an editor whose container lit was about to replace.
   */
  test("a commit that throws still cancels, and is reported rather than rethrown", async () => {
    resetNotifications();
    const buffer = fakeBuffer("return 1;") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    buffer._editingTab = { documentPath: "pages/index.md", id: "t" } as unknown as Tab;
    const writes = bufferWrites(buffer);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 500, () => {
      throw new TypeError("undefined is not an object (evaluating 'node[key]')");
    });
    const linted: string[] = [];
    writes.arm("lint", 10, () => {
      linted.push("lint");
    });

    expect(commitBufferWrites(buffer, "logic")).toBe(false);

    const toast = toasts.find((t) => t.key === "buffer-discarded:logic:t");
    expect(toast?.detail).toContain("undefined is not an object");
    // The teardown happened anyway: no orphan timer is left to read `""` off a detached model.
    await sleep(40);
    expect(linted).toEqual([]);
  });

  test("an async commit that rejects is reported the same way", async () => {
    resetNotifications();
    const buffer = fakeBuffer("# page") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    buffer._editingTab = { documentPath: "pages/about.md", id: "r" } as unknown as Tab;
    const writes = bufferWrites(buffer);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 600, async () => {
      await sleep(5);
      throw new Error("the format host is down");
    });

    expect(commitBufferWrites(buffer, "source")).toBe(true);
    await sleep(30);
    const toast = toasts.find((t) => t.key === "buffer-discarded:source:r");
    expect(toast?.detail).toContain("the format host is down");
  });

  test("a buffer that names no tab still gets a sentence", () => {
    resetNotifications();
    const buffer = fakeBuffer("orphan");
    const writes = bufferWrites(buffer);
    writes.markTyped();
    expect(commitBufferWrites(buffer, "logic")).toBe(false);
    const toast = toasts.find((t) => t.key === "buffer-discarded:logic:none");
    expect(toast?.message).toContain('"Untitled"');
    expect(toast?.path).toBeUndefined();
  });
});

describe("cancelBufferWrites", () => {
  test("is safe on nothing and on a buffer that never armed anything", () => {
    const nothing = undefined as MonacoBuffer | null | undefined;
    expect(() => cancelBufferWrites(null)).not.toThrow();
    expect(() => cancelBufferWrites(nothing)).not.toThrow();
    expect(() => cancelBufferWrites(fakeBuffer())).not.toThrow();
  });
});

/**
 * THE TAB'S BUFFERS, asked as one question.
 *
 * The two gates that destroy a tab — `requestClose` (⌘W and the ×) and `hasUnsavedTabs`
 * (`beforeunload`) — must not each learn about two editors, and until now they could not have: the
 * dock's editor named its tab on the instance, the source view named its tab only inside a closure,
 * so "is this buffer this tab's?" was a question one surface could answer and the other could not.
 */
const tabA = { id: "a" } as unknown as Tab;
const tabB = { id: "b" } as unknown as Tab;

/** A buffer mounted for `tab`, with a commit armed that writes `value` into `landed`. */
function mountedBuffer(tab: Tab | null, value: string, landed: string[], ms = 500) {
  const buffer = fakeBuffer(value) as ReturnType<typeof fakeBuffer> & { _editingTab?: Tab | null };
  buffer._editingTab = tab;
  const writes = bufferWrites(buffer);
  writes.markTyped();
  writes.arm(BUFFER_COMMIT, ms, () => {
    landed.push(buffer.getValue());
    writes.markSettled();
  });
  return buffer;
}

afterEach(() => {
  surfaceForPane("primary").monacoEditor = null;
  view.functionEditor = null;
});

describe("commitTabBuffers", () => {
  test("runs the armed commit of every buffer mounted for the tab", async () => {
    const landed: string[] = [];
    view.functionEditor = mountedBuffer(tabA, "return typed();", landed) as never;
    surfaceForPane("primary").monacoEditor = mountedBuffer(tabA, "# Never saved", landed) as never;

    await commitTabBuffers(tabA);

    expect(landed.toSorted()).toEqual(["# Never saved", "return typed();"]);
    expect(tabBufferUnsaved(tabA)).toBe(false);
  });

  test("and no other tab's — a × on one chip is not a commit for the strip", async () => {
    const landed: string[] = [];
    view.functionEditor = mountedBuffer(tabB, "b's handler", landed) as never;
    await commitTabBuffers(tabA);
    expect(landed).toEqual([]);
    expect(tabBufferUnsaved(tabA)).toBe(false);
    expect(tabBufferUnsaved(tabB)).toBe(true);
  });

  /* The close asks its question on the very next line, so a commit that is still parsing has not
     answered yet. The source view's is exactly that: it awaits the format host before it assigns. */
  test("waits for an async commit before returning", async () => {
    const landed: string[] = [];
    const buffer = fakeBuffer("# Never saved") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    buffer._editingTab = tabA;
    const writes = bufferWrites(buffer);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 600, async () => {
      const text = buffer.getValue();
      await sleep(10);
      landed.push(text);
      writes.markSettled();
    });
    surfaceForPane("primary").monacoEditor = buffer as never;

    await commitTabBuffers(tabA);
    expect(landed).toEqual(["# Never saved"]);
  });

  test("leaves everything else armed — the tab may survive the prompt it just caused", async () => {
    const landed: string[] = [];
    const buffer = mountedBuffer(tabA, "typed", landed);
    const linted: string[] = [];
    buffer._writes!.arm("lint", 10, () => {
      linted.push("lint");
    });

    await commitTabBuffers(tabA);
    await sleep(40);
    // Cancel-after-flush is a DISPOSER's order. Cancel here and an author who pressed Keep Editing
    // Would be left in a buffer whose lint never arrives.
    expect(linted).toEqual(["lint"]);
  });

  test("a disposed buffer is never read, and an unmounted surface is never asked", async () => {
    const landed: string[] = [];
    const buffer = mountedBuffer(tabA, "return 1;", landed);
    buffer.dispose();
    view.functionEditor = buffer as never;
    await commitTabBuffers(tabA);
    // Clause 1: a detached model answers `""`, so reading it is the deletion the flush prevents.
    expect(landed).toEqual([]);
    expect(tabBufferUnsaved(tabA)).toBe(false);

    view.functionEditor = null;
    surfaceForPane("primary").monacoEditor = null;
    await commitTabBuffers(tabA);
    expect(tabBufferUnsaved(tabA)).toBe(false);
  });

  /**
   * TWO SURFACES ON ONE TAB, and their two commits are not independent.
   *
   * The dock's Logic editor is not a canvas mode, so a handler body and the page source are
   * editable side by side. Their commits write at different granularities: the dock's puts ONE body
   * at `editing.path`; the source view's parses the whole buffer and assigns a whole new
   * `tab.doc.document`, built from text that predates the dock's write. Started together, the
   * synchronous body write lands first and the parse replaces the entire tree on top of it — so the
   * body the author just typed is gone, with `dirty` set and nothing saying what went missing.
   *
   * Two independent timers could already race this either way. Flushing them in one turn makes the
   * loser certain, so the turn has to pick the survivable order: `bodyWriter` re-reads
   * `tab.doc.document` and re-resolves `editing.path` at call time, so a body write applied AFTER a
   * document replacement lands on the new tree. The reverse recovers nothing.
   */
  test("the source's whole-document assign lands BEFORE the dock's body write", async () => {
    const landed: string[] = [];
    const source = fakeBuffer("# the page") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    source._editingTab = tabA;
    const writes = bufferWrites(source);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 600, async () => {
      const text = source.getValue();
      await sleep(10); // The format host.
      landed.push(`document := ${text}`);
      writes.markSettled();
    });
    surfaceForPane("primary").monacoEditor = source as never;
    view.functionEditor = mountedBuffer(tabA, "typed();", landed) as never;

    await commitTabBuffers(tabA);

    expect(landed).toEqual(["document := # the page", "typed();"]);
  });

  /* And the ordering opens its own hole: the list was taken before the first commit's await, and
     assigning a document repaints the dock — which can dispose the function editor inside it. */
  test("a buffer disposed by the commit before it is never read", async () => {
    const landed: string[] = [];
    const dock = mountedBuffer(tabA, "typed();", landed);
    const source = fakeBuffer("# the page") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    source._editingTab = tabA;
    const writes = bufferWrites(source);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 600, async () => {
      await sleep(10);
      dock.dispose();
    });
    surfaceForPane("primary").monacoEditor = source as never;
    view.functionEditor = dock as never;

    await commitTabBuffers(tabA);
    // A detached model answers `""`, and committing that is the deletion the flush exists to stop.
    expect(landed).toEqual([]);
  });

  /**
   * A COMMIT THAT THROWS MUST NOT SWALLOW THE GESTURE.
   *
   * `requestClose` awaits this before it asks anything, and a rejection propagated straight out of
   * an `async` function nobody awaits: ⌘W did nothing — no prompt, no close, no message, an
   * unhandled rejection in the console. The other two callers do not even await it, so a rejection
   * there is invisible by construction.
   *
   * And a commit is not all-or-nothing: the source view writes a whole document and the dock writes
   * one body, so the first one throwing must not cost the second its turn.
   */
  test("a commit that throws is reported, and the other buffer still commits", async () => {
    resetNotifications();
    const landed: string[] = [];
    const source = fakeBuffer("# the page") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    source._editingTab = tabA;
    const writes = bufferWrites(source);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 600, async () => {
      await sleep(5);
      throw new Error("the format host is down");
    });
    surfaceForPane("primary").monacoEditor = source as never;
    view.functionEditor = mountedBuffer(tabA, "typed();", landed) as never;

    // It resolves rather than rejecting, which is what keeps ⌘W a gesture that does something.
    await commitTabBuffers(tabA);

    expect(landed).toEqual(["typed();"]);
    // The failure is a Problem, not a toast: an author reading it minutes later still needs to
    // Know one document's editor holds text the file does not.
    const problem = problems.find((p) => p.key === `buffer-commit:${tabA.id}`);
    expect(problem?.tier).toBe("problem");
    expect(problem?.detail).toContain("the format host is down");
    // And the buffer never settled, so every close gate still sees the work.
    expect(source._writes!.typed()).toBe(true);
    expect(tabBufferUnsaved(tabA)).toBe(true);
  });

  test("a buffer that names no tab belongs to no tab", async () => {
    const landed: string[] = [];
    surfaceForPane("primary").monacoEditor = mountedBuffer(null, "orphan", landed) as never;
    await commitTabBuffers(tabA);
    expect(landed).toEqual([]);
    expect(tabBufferUnsaved(tabA)).toBe(false);
  });
});

describe("tabBufferUnsaved", () => {
  test("is the author's own typing, not a buffer that is merely ahead", () => {
    const formatted = fakeBuffer("return 1;\n") as ReturnType<typeof fakeBuffer> & {
      _editingTab?: Tab | null;
    };
    formatted._editingTab = tabA;
    bufferWrites(formatted).markAhead();
    view.functionEditor = formatted as never;
    // Format-on-open, against a body `closeFunctionEditor` minified: ahead for as long as the
    // Editor is open, and nothing an author loses. Quitting must not stop to ask about it.
    expect(tabBufferUnsaved(tabA)).toBe(false);
  });
});
