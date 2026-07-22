import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxDocOp } from "../src/ops.ts";
import { applyDocOpToDoc } from "../src/ops.ts";
import {
  applyDocOpsToY,
  CollabPathError,
  LOCAL_ORIGIN,
  yEventsToDocOps,
} from "../src/op-bridge.ts";
import { seedStructure, yDocToJson } from "../src/schema.ts";

const BASE: JxMutableNode = {
  children: [
    { tagName: "h1", textContent: "Title" },
    { children: [{ tagName: "p", textContent: "one" }], tagName: "section" },
    "loose",
  ],
  tagName: "div",
};

function fresh(): { ydoc: Y.Doc; mirror: JxMutableNode } {
  const ydoc = new Y.Doc();
  seedStructure(ydoc, BASE);
  return { mirror: structuredClone(BASE), ydoc };
}

/** Apply ops to both representations and assert they agree. */
function applyBoth(state: { ydoc: Y.Doc; mirror: JxMutableNode }, ops: JxDocOp[]) {
  for (const op of ops) {
    applyDocOpToDoc(state.mirror, op);
  }
  applyDocOpsToY(state.ydoc, ops, LOCAL_ORIGIN);
  expect(yDocToJson(state.ydoc)).toEqual(state.mirror);
}

describe("applyDocOpsToY mirrors the plain applier", () => {
  test("set-key on a nested node (value, delete, and children replacement)", () => {
    const state = fresh();
    applyBoth(state, [
      { key: "textContent", op: "set-key", path: ["children", 0], value: "New title" },
      { key: "style", op: "set-key", path: ["children", 0], value: { color: "red" } },
    ]);
    applyBoth(state, [{ key: "style", op: "set-key", path: ["children", 0] }]);
    applyBoth(state, [
      {
        key: "children",
        op: "set-key",
        path: ["children", 1],
        value: [{ tagName: "em", textContent: "replaced" }, "tail"],
      },
    ]);
  });

  test("insert/remove/set/move children (nodes and strings)", () => {
    const state = fresh();
    applyBoth(state, [
      { index: 1, node: { tagName: "aside" }, op: "insert-child", parentPath: [] },
      { index: 0, node: "lead-in", op: "insert-child", parentPath: [] },
    ]);
    applyBoth(state, [{ index: 0, op: "remove-child", parentPath: [] }]);
    applyBoth(state, [
      { index: 0, node: { tagName: "h2", textContent: "T2" }, op: "set-child", parentPath: [] },
    ]);
    applyBoth(state, [
      { fromIndex: 0, fromParentPath: [], op: "move-child", toIndex: 1, toParentPath: [] },
    ]);
    applyBoth(state, [
      {
        fromIndex: 0,
        fromParentPath: [],
        op: "move-child",
        toIndex: 0,
        toParentPath: ["children", 2],
      },
    ]);
  });

  test("insert-child creates a children array on a leaf node", () => {
    const state = fresh();
    applyBoth(state, [
      { index: 0, node: { tagName: "b" }, op: "insert-child", parentPath: ["children", 0] },
    ]);
  });

  test("unresolvable paths throw CollabPathError", () => {
    const { ydoc } = fresh();
    expect(() =>
      applyDocOpsToY(ydoc, [{ key: "x", op: "set-key", path: ["children", 9] }], LOCAL_ORIGIN),
    ).toThrow(CollabPathError);
    expect(() =>
      applyDocOpsToY(ydoc, [{ index: 9, op: "remove-child", parentPath: [] }], LOCAL_ORIGIN),
    ).toThrow(CollabPathError);
    expect(() =>
      applyDocOpsToY(
        ydoc,
        [{ index: 9, node: { tagName: "x" }, op: "insert-child", parentPath: [] }],
        LOCAL_ORIGIN,
      ),
    ).toThrow(CollabPathError);
    // A string child is not a node: set-key on it must refuse.
    expect(() =>
      applyDocOpsToY(ydoc, [{ key: "x", op: "set-key", path: ["children", 2] }], LOCAL_ORIGIN),
    ).toThrow(CollabPathError);
  });

  test("child ops against a missing or non-array children key throw CollabPathError", () => {
    const { ydoc } = fresh();
    // The h1 leaf has no children array and remove-child must not create one.
    expect(() =>
      applyDocOpsToY(
        ydoc,
        [{ index: 0, op: "remove-child", parentPath: ["children", 0] }],
        LOCAL_ORIGIN,
      ),
    ).toThrow(CollabPathError);
    // A children key holding a non-array value is unusable even for inserts.
    applyDocOpsToY(
      ydoc,
      [{ key: "children", op: "set-key", path: ["children", 0], value: "not-an-array" }],
      LOCAL_ORIGIN,
    );
    expect(() =>
      applyDocOpsToY(
        ydoc,
        [{ index: 0, node: { tagName: "b" }, op: "insert-child", parentPath: ["children", 0] }],
        LOCAL_ORIGIN,
      ),
    ).toThrow(CollabPathError);
  });

  test("set-child and move-child index bounds throw CollabPathError", () => {
    const { ydoc } = fresh();
    expect(() =>
      applyDocOpsToY(
        ydoc,
        [{ index: 9, node: { tagName: "x" }, op: "set-child", parentPath: [] }],
        LOCAL_ORIGIN,
      ),
    ).toThrow(CollabPathError);
    expect(() =>
      applyDocOpsToY(
        ydoc,
        [{ fromIndex: 9, fromParentPath: [], op: "move-child", toIndex: 0, toParentPath: [] }],
        LOCAL_ORIGIN,
      ),
    ).toThrow(CollabPathError);
    // The source index resolves, so the removal commits before the target bound check fires.
    expect(() =>
      applyDocOpsToY(
        ydoc,
        [{ fromIndex: 0, fromParentPath: [], op: "move-child", toIndex: 9, toParentPath: [] }],
        LOCAL_ORIGIN,
      ),
    ).toThrow(CollabPathError);
  });

  test("an unknown op kind throws a plain error (not CollabPathError)", () => {
    const { ydoc } = fresh();
    expect(() =>
      applyDocOpsToY(ydoc, [{ op: "explode" } as unknown as JxDocOp], LOCAL_ORIGIN),
    ).toThrow("unknown-doc-op:explode");
  });
});

describe("two docs wired memory-to-memory converge", () => {
  function wirePair(): { a: Y.Doc; b: Y.Doc } {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedStructure(a, BASE);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.on("update", (update: Uint8Array) => Y.applyUpdate(b, update, "from-a"));
    b.on("update", (update: Uint8Array) => Y.applyUpdate(a, update, "from-b"));
    return { a, b };
  }

  test("sequential edits from both sides arrive at one tree", () => {
    const { a, b } = wirePair();
    applyDocOpsToY(
      a,
      [{ key: "textContent", op: "set-key", path: ["children", 0], value: "From A" }],
      LOCAL_ORIGIN,
    );
    applyDocOpsToY(
      b,
      [{ index: 0, node: { tagName: "nav" }, op: "insert-child", parentPath: [] }],
      LOCAL_ORIGIN,
    );
    expect(yDocToJson(a)).toEqual(yDocToJson(b));
    const doc = yDocToJson(a) as { children: { tagName?: string; textContent?: string }[] };
    expect(doc.children[0]!.tagName).toBe("nav");
    expect(doc.children[1]!.textContent).toBe("From A");
  });

  test("concurrent sibling inserts both survive (CRDT merge)", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedStructure(a, BASE);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // Concurrent: neither has seen the other's insert yet.
    applyDocOpsToY(
      a,
      [{ index: 0, node: { tagName: "a-side" }, op: "insert-child", parentPath: [] }],
      LOCAL_ORIGIN,
    );
    applyDocOpsToY(
      b,
      [{ index: 0, node: { tagName: "b-side" }, op: "insert-child", parentPath: [] }],
      LOCAL_ORIGIN,
    );
    const updateA = Y.encodeStateAsUpdate(a);
    const updateB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, updateB);
    Y.applyUpdate(b, updateA);
    const docA = yDocToJson(a);
    expect(yDocToJson(b)).toEqual(docA);
    expect((docA as { children: unknown[] }).children).toHaveLength(5);
  });
});

describe("yEventsToDocOps (fast inbound path)", () => {
  /**
   * Replay one remote transaction from A into B and convert B's deep events INSIDE the observer
   * callback (yjs forbids reading event.changes after the transaction), like the bridge does.
   */
  function captureRemote(mutate: (a: Y.Doc) => void): {
    ops: JxDocOp[] | null;
    observed: boolean;
    b: Y.Doc;
    before: JxMutableNode;
  } {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedStructure(a, BASE);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const before = yDocToJson(b);
    let ops: JxDocOp[] | null = null;
    let observed = false;
    b.getMap("structure").observeDeep((events) => {
      observed = true;
      ops = yEventsToDocOps(events as unknown as Y.YEvent<never>[]);
    });
    mutate(a);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    return { b, before, observed, ops };
  }

  /** The invariant: converting events and replaying them reproduces the post state. */
  function assertFaithful(result: ReturnType<typeof captureRemote>) {
    expect(result.observed).toBe(true);
    expect(result.ops).not.toBeNull();
    const replayed = structuredClone(result.before);
    for (const op of result.ops!) {
      applyDocOpToDoc(replayed, op);
    }
    expect(replayed).toEqual(yDocToJson(result.b));
    return result.ops!;
  }

  test("single set-key converts to the same op", () => {
    const result = captureRemote((a) => {
      applyDocOpsToY(
        a,
        [{ key: "textContent", op: "set-key", path: ["children", 0], value: "Remote" }],
        LOCAL_ORIGIN,
      );
    });
    expect(assertFaithful(result)).toEqual([
      { key: "textContent", op: "set-key", path: ["children", 0], value: "Remote" },
    ]);
  });

  test("key deletion converts to a value-less set-key", () => {
    const result = captureRemote((a) => {
      applyDocOpsToY(a, [{ key: "textContent", op: "set-key", path: ["children", 0] }], "x");
    });
    expect(assertFaithful(result)).toEqual([
      { key: "textContent", op: "set-key", path: ["children", 0] },
    ]);
  });

  test("array splices convert with sequential-replay indices", () => {
    const result = captureRemote((a) => {
      applyDocOpsToY(
        a,
        [
          { index: 0, op: "remove-child", parentPath: [] },
          { index: 1, node: { tagName: "new" }, op: "insert-child", parentPath: [] },
        ],
        "x",
      );
    });
    assertFaithful(result);
  });

  test("nested children splice addresses the right parent", () => {
    const result = captureRemote((a) => {
      applyDocOpsToY(
        a,
        [
          {
            index: 1,
            node: { tagName: "p", textContent: "two" },
            op: "insert-child",
            parentPath: ["children", 1],
          },
        ],
        "x",
      );
    });
    const ops = assertFaithful(result);
    expect(ops![0]).toMatchObject({ op: "insert-child", parentPath: ["children", 1] });
  });

  test("overlapping multi-target transactions bail to null (diff fallback)", () => {
    const result = captureRemote((a) => {
      // One transaction touching the root children array AND a nested node (post-insert path).
      applyDocOpsToY(
        a,
        [
          { index: 0, node: { tagName: "x" }, op: "insert-child", parentPath: [] },
          {
            key: "textContent",
            op: "set-key",
            path: ["children", 2, "children", 0],
            value: "nested",
          },
        ],
        "x",
      );
    });
    expect(result.observed).toBe(true);
    expect(result.ops).toBeNull();
  });

  test("empty event list produces no ops", () => {
    expect(yEventsToDocOps([])).toEqual([]);
  });

  test("a path with a non-string/number segment bails to null", () => {
    const fake = { path: [Symbol("weird")] } as unknown as Y.YEvent<never>;
    expect(yEventsToDocOps([fake])).toBeNull();
  });

  test("two array events in one transaction bail to null", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedStructure(a, {
      children: [
        { children: [{ tagName: "p" }], tagName: "section" },
        { children: [{ tagName: "p" }], tagName: "aside" },
      ],
      tagName: "div",
    });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    let ops: JxDocOp[] | null | "unset" = "unset";
    b.getMap("structure").observeDeep((events) => {
      ops = yEventsToDocOps(events as unknown as Y.YEvent<never>[]);
    });
    // One transaction splicing two disjoint children arrays: neither path contains the other, so
    // The overlap guard passes and the multi-array guard must bail.
    applyDocOpsToY(
      a,
      [
        { index: 0, node: "x", op: "insert-child", parentPath: ["children", 0] },
        { index: 0, node: "y", op: "insert-child", parentPath: ["children", 1] },
      ],
      "x",
    );
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(ops).toBeNull();
  });

  test("an array event off the children key bails to null", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedStructure(a, BASE);
    // A Y.Array living under a key other than "children" is not part of the structure contract.
    a.getMap("structure").set("items", new Y.Array<unknown>());
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    let ops: JxDocOp[] | null | "unset" = "unset";
    b.getMap("structure").observeDeep((events) => {
      ops = yEventsToDocOps(events as unknown as Y.YEvent<never>[]);
    });
    a.transact(() => {
      (a.getMap("structure").get("items") as Y.Array<unknown>).insert(0, ["x"]);
    });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(ops).toBeNull();
  });
});
