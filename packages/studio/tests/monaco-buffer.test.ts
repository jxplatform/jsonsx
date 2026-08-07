/**
 * The one rule both Monaco surfaces owe (`services/monaco-buffer.ts`).
 *
 * Studio has two Monaco editors, mounted by different modules and torn down by different events,
 * and each of the five writes into or out of them had grown its own guard. All five asked identity
 * — "is this still the same editor object?" — which is a different question from "has the buffer
 * moved on?", and is passed by a repaint into a live editor mid-word. These tests pin the four
 * clauses of the shared predicate in isolation; `tests/editors.test.ts` and
 * `tests/canvas-render.test.ts` pin what each call site does with the answer.
 */
import { describe, expect, test } from "bun:test";
import {
  BUFFER_COMMIT,
  bufferIsLive,
  bufferMovedOn,
  bufferWrites,
  cancelBufferWrites,
  commitBufferWrites,
} from "../src/services/monaco-buffer";
import type { MonacoBuffer } from "../src/services/monaco-buffer";

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
});

describe("bufferWrites", () => {
  test("arming the same key replaces the previous timer rather than adding one", async () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    const ran: string[] = [];
    writes.arm(BUFFER_COMMIT, 10, () => ran.push("first"));
    writes.arm(BUFFER_COMMIT, 10, () => ran.push("second"));
    await sleep(40);
    expect(ran).toEqual(["second"]);
    // A fired timer leaves nothing to flush — the key is dropped before the body runs, so a
    // Teardown arriving during the commit cannot run it a second time.
    writes.flush(BUFFER_COMMIT);
    expect(ran).toEqual(["second"]);
  });

  test("different keys are independent, and cancel drops all of them", async () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    const ran: string[] = [];
    writes.arm(BUFFER_COMMIT, 10, () => ran.push("commit"));
    writes.arm("lint", 15, () => ran.push("lint"));
    writes.cancel();
    await sleep(40);
    expect(ran).toEqual([]);
    // Cancelled means gone, not merely un-timed: a later flush has nothing to find.
    writes.flush(BUFFER_COMMIT);
    expect(ran).toEqual([]);
  });

  test("it is installed on the buffer, so the disposer holds the canceller", async () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    expect(buffer._writes).toBe(writes);
    const ran: string[] = [];
    writes.arm(BUFFER_COMMIT, 10, () => ran.push("commit"));
    cancelBufferWrites(buffer);
    await sleep(40);
    expect(ran).toEqual([]);
  });

  test("flush runs the armed work now, and only under the key asked for", async () => {
    const buffer = fakeBuffer();
    const writes = bufferWrites(buffer);
    const ran: string[] = [];
    writes.arm(BUFFER_COMMIT, 500, () => ran.push("commit"));
    writes.arm("lint", 750, () => ran.push("lint"));

    writes.flush(BUFFER_COMMIT);
    expect(ran).toEqual(["commit"]);

    // And the timer it just ran is gone, so it does not also fire on its own schedule.
    await sleep(40);
    expect(ran).toEqual(["commit"]);
    writes.flush("nothing-armed-here");
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
    writes.arm(BUFFER_COMMIT, 500, () => written.push(buffer.getValue()));
    writes.arm("lint", 750, () => linted.push(buffer.getValue()));

    commitBufferWrites(buffer);
    buffer.dispose();

    // The commit ran against the LIVE buffer — `"return 42;"`, not the `""` a detached model answers.
    expect(written).toEqual(["return 42;"]);
    // The lint did not. A round trip started for an editor being disposed answers to nobody.
    expect(linted).toEqual([]);
    // And nothing is left armed to fire afterwards.
    writes.flush(BUFFER_COMMIT);
    expect(written).toEqual(["return 42;"]);
  });

  test("is safe on nothing, and on a buffer that never armed a commit", () => {
    const nothing = undefined as MonacoBuffer | null | undefined;
    expect(() => commitBufferWrites(null)).not.toThrow();
    expect(() => commitBufferWrites(nothing)).not.toThrow();
    expect(() => commitBufferWrites(fakeBuffer())).not.toThrow();
    const buffer = fakeBuffer();
    bufferWrites(buffer);
    expect(() => commitBufferWrites(buffer)).not.toThrow();
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
