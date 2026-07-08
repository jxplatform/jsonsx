import { describe, expect, test } from "bun:test";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  acquireSourceCanonical,
  canonicalOf,
  canonicalRevOf,
  isSourceReconciler,
  otherSourceEditors,
  releaseSourceCanonical,
} from "../src/source-lock.ts";
import { seedStructure, sourceText } from "../src/schema.ts";

describe("canonical lock", () => {
  test("acquire seeds the text, flips canonical, and bumps the rev", () => {
    const doc = new Doc();
    seedStructure(doc, { tagName: "div" });
    expect(canonicalOf(doc)).toBe("structure");
    const rev = canonicalRevOf(doc);

    expect(acquireSourceCanonical(doc, `{"tagName":"div"}`, "test")).toBe(true);
    expect(canonicalOf(doc)).toBe("source");
    expect(canonicalRevOf(doc)).toBe(rev + 1);
    expect(sourceText(doc).toString()).toBe(`{"tagName":"div"}`);

    // Idempotent while held.
    expect(acquireSourceCanonical(doc, "other", "test")).toBe(false);
    expect(sourceText(doc).toString()).toBe(`{"tagName":"div"}`);

    expect(releaseSourceCanonical(doc, "test")).toBe(true);
    expect(canonicalOf(doc)).toBe("structure");
    expect(canonicalRevOf(doc)).toBe(rev + 2);
    expect(releaseSourceCanonical(doc, "test")).toBe(false);
  });

  test("concurrent acquires converge (LWW meta, merged identical text)", () => {
    const a = new Doc();
    const b = new Doc();
    seedStructure(a, { tagName: "div" });
    applyUpdate(b, encodeStateAsUpdate(a));

    acquireSourceCanonical(a, "same-serialization", "a");
    acquireSourceCanonical(b, "same-serialization", "b");
    applyUpdate(a, encodeStateAsUpdate(b));
    applyUpdate(b, encodeStateAsUpdate(a));

    expect(canonicalOf(a)).toBe("source");
    expect(sourceText(a).toString()).toBe(sourceText(b).toString());
  });
});

describe("source editor election", () => {
  function awarenessWith(states: [number, Record<string, unknown>][], selfId: number): Awareness {
    const awareness = new Awareness(new Doc());
    Object.defineProperty(awareness, "clientID", { value: selfId });
    const map = awareness.getStates();
    map.clear();
    for (const [id, state] of states) {
      map.set(id, state);
      awareness.meta.set(id, { clock: 1, lastUpdated: 0 });
    }
    return awareness;
  }

  test("otherSourceEditors filters by path and mode, excluding self", () => {
    const awareness = awarenessWith(
      [
        [1, { focusedPath: "a.md", mode: "source" }],
        [2, { focusedPath: "a.md", mode: "source" }],
        [3, { focusedPath: "b.md", mode: "source" }],
        [4, { focusedPath: "a.md", mode: "structure" }],
      ],
      1,
    );
    expect(otherSourceEditors(awareness, "a.md", 1)).toEqual([2]);
    awareness.destroy();
  });

  test("the lowest write-capable source editor is the reconciler", () => {
    const awareness = awarenessWith(
      [
        [5, { canWrite: false, focusedPath: "a.md", mode: "source" }],
        [7, { focusedPath: "a.md", mode: "source" }],
        [9, { focusedPath: "a.md", mode: "source" }],
      ],
      7,
    );
    // 5 is read-only; 7 is the lowest writer.
    expect(isSourceReconciler(awareness, "a.md")).toBe(true);
    awareness.destroy();

    const notLowest = awarenessWith(
      [
        [2, { focusedPath: "a.md", mode: "source" }],
        [7, { focusedPath: "a.md", mode: "source" }],
      ],
      7,
    );
    expect(isSourceReconciler(notLowest, "a.md")).toBe(false);
    notLowest.destroy();

    const notInSource = awarenessWith([[7, { focusedPath: "a.md", mode: "structure" }]], 7);
    expect(isSourceReconciler(notInSource, "a.md")).toBe(false);
    notInSource.destroy();
  });
});
