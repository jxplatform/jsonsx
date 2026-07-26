/**
 * Patch-op recording and transactDoc → patch-consumer wiring. Verifies that every instrumented
 * mutator emits the right ops, that un-instrumented mutations escalate, and that the
 * consumed-reference handshake and apply/escalate flow behave.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toRaw } from "../src/reactivity";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import {
  beginRecording,
  endRecording,
  markNonInvertible,
  setPatchConsumer,
} from "../src/tabs/patch-ops";
import {
  mutateAddDef,
  mutateDuplicateNode,
  mutateInsertNode,
  mutateMoveNode,
  mutateRemoveNode,
  mutateUpdateAttribute,
  mutateUpdateMedia,
  mutateUpdateMediaStyle,
  mutateUpdateProp,
  mutateUpdateProperty,
  mutateUpdateStyle,
  mutateWrapNode,
  redo,
  transact,
  transactDoc,
  undo,
} from "../src/tabs/transact";

import type { JxPatchOp } from "../src/tabs/patch-ops";
import type { Tab } from "../src/tabs/tab";

let tab: Tab;
let tabCount = 0;

interface ConsumerLog {
  classified: JxPatchOp[][];
  marked: object[];
  applied: JxPatchOp[][];
  /** The VALUE-CARRYING forward ops each apply received — what actually crosses to the canvas. */
  appliedDocOps: unknown[][];
  escalated: string[];
}

function installConsumer({
  patchable = true,
  applyThrows = false,
}: { patchable?: boolean; applyThrows?: boolean } = {}): ConsumerLog {
  const log: ConsumerLog = {
    applied: [],
    appliedDocOps: [],
    classified: [],
    escalated: [],
    marked: [],
  };
  setPatchConsumer({
    apply: (_tab, ops, record) => {
      log.applied.push(ops);
      log.appliedDocOps.push((record?.docOps ?? []).map((pair) => pair.forward));
      if (applyThrows) {
        throw new Error("boom");
      }
    },
    classify: (_tab, ops) => {
      log.classified.push(ops);
      return { patchable, reason: patchable ? "" : "test-reject" };
    },
    escalate: (reason) => {
      log.escalated.push(reason);
    },
    markConsumed: (ref) => {
      log.marked.push(ref);
    },
  });
  return log;
}

function freshDoc() {
  return {
    children: [
      { style: { color: "red" }, tagName: "p", textContent: "hello" },
      { tagName: "span", textContent: "world" },
    ],
    tagName: "div",
  };
}

beforeEach(() => {
  tabCount += 1;
  tab = openTab({ document: freshDoc(), id: `patch-test-${tabCount}` }) as Tab;
});

afterEach(() => {
  setPatchConsumer(null);
  closeAllTabs();
});

describe("mutator op recording", () => {
  function opsFor(mutation: (t: Tab) => void): JxPatchOp[] {
    const log = installConsumer();
    transactDoc(tab, mutation);
    expect(log.classified.length).toBe(1);
    return log.classified[0]!;
  }

  test("mutateUpdateStyle → set-style", () => {
    const ops = opsFor((t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
    expect(ops).toEqual([{ op: "set-style", path: ["children", 0] }]);
  });

  test("mutateUpdateMediaStyle → set-style (including the no-media delegation)", () => {
    const withMedia = opsFor((t) =>
      mutateUpdateMediaStyle(t, ["children", 0], "sm", "color", "blue"),
    );
    expect(withMedia).toEqual([{ op: "set-style", path: ["children", 0] }]);
    const noMedia = opsFor((t) => mutateUpdateMediaStyle(t, ["children", 0], "", "color", "blue"));
    expect(noMedia).toEqual([{ op: "set-style", path: ["children", 0] }]);
  });

  test("mutateUpdateProperty textContent → set-text", () => {
    const ops = opsFor((t) => mutateUpdateProperty(t, ["children", 0], "textContent", "hi"));
    expect(ops).toEqual([{ op: "set-text", path: ["children", 0] }]);
  });

  test("mutateUpdateProperty event binding → set-prop with isEvent", () => {
    const ops = opsFor((t) =>
      mutateUpdateProperty(t, ["children", 0], "onclick", { $ref: "#/state/handler" }),
    );
    expect(ops).toEqual([{ isEvent: true, key: "onclick", op: "set-prop", path: ["children", 0] }]);
  });

  test("mutateUpdateProperty deleting an event binding keeps isEvent via the previous value", () => {
    transact(tab, (doc) => {
      const first = (doc.children as Record<string, unknown>[])[0]!;
      first["onclick"] = { $ref: "#/state/handler" };
    });
    const ops = opsFor((t) => mutateUpdateProperty(t, ["children", 0], "onclick"));
    expect(ops).toEqual([{ isEvent: true, key: "onclick", op: "set-prop", path: ["children", 0] }]);
  });

  test("mutateUpdateProperty plain property → set-prop without isEvent", () => {
    const ops = opsFor((t) => mutateUpdateProperty(t, ["children", 0], "href", "/x"));
    expect(ops).toEqual([{ isEvent: false, key: "href", op: "set-prop", path: ["children", 0] }]);
  });

  test("mutateUpdateAttribute → set-attr", () => {
    const ops = opsFor((t) => mutateUpdateAttribute(t, ["children", 0], "title", "t"));
    expect(ops).toEqual([{ attr: "title", op: "set-attr", path: ["children", 0] }]);
  });

  test("structural mutators → insert/remove/move/replace", () => {
    expect(opsFor((t) => mutateInsertNode(t, [], 1, { tagName: "div" }))).toEqual([
      { index: 1, op: "insert", parentPath: [] },
    ]);
    expect(opsFor((t) => mutateRemoveNode(t, ["children", 0]))).toEqual([
      { op: "remove", path: ["children", 0] },
    ]);
    expect(opsFor((t) => mutateDuplicateNode(t, ["children", 0]))).toEqual([
      { index: 1, op: "insert", parentPath: [] },
    ]);
    expect(opsFor((t) => mutateWrapNode(t, ["children", 0]))).toEqual([
      { op: "replace", path: ["children", 0] },
    ]);
    expect(opsFor((t) => mutateMoveNode(t, ["children", 0], [], 2))).toEqual([
      { fromPath: ["children", 0], op: "move", toIndex: 1, toParentPath: [] },
    ]);
  });

  test("compound transaction records all ops in order", () => {
    const ops = opsFor((t) => {
      mutateUpdateProperty(t, ["children", 0], "textContent", "a");
      mutateInsertNode(t, [], 1, { tagName: "p" });
    });
    expect(ops.map((o) => o.op)).toEqual(["set-text", "insert"]);
  });

  test("doc-level mutators → doc-meta", () => {
    expect(opsFor((t) => mutateAddDef(t, "count", { default: 0 }))).toEqual([
      { key: "state", op: "doc-meta" },
    ]);
    expect(opsFor((t) => mutateUpdateMedia(t, "sm", "(max-width: 640px)"))).toEqual([
      { key: "$media", op: "doc-meta" },
    ]);
    expect(opsFor((t) => mutateUpdateProp(t, ["children", 0], "label", "x"))).toEqual([
      { op: "replace", path: ["children", 0] },
    ]);
  });
});

describe("recording primitives", () => {
  test("markNonInvertible flags the current transaction record", () => {
    beginRecording();
    markNonInvertible();
    const record = endRecording();
    expect(record.invertible).toBe(false);
    // Recording state resets after endRecording.
    beginRecording();
    expect(endRecording().invertible).toBe(true);
  });
});

describe("transactDoc consumer wiring", () => {
  test("patchable verdict marks the new root reference consumed, then applies", () => {
    const log = installConsumer({ patchable: true });
    transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
    expect(log.marked.length).toBe(1);
    expect(log.marked[0]).toBe(toRaw(tab.doc.document) as object);
    expect(log.applied.length).toBe(1);
    expect(log.escalated.length).toBe(0);
    expect(tab.doc.dirty).toBe(true);
    expect(tab.history.snapshots.length).toBe(2);
  });

  test("non-patchable verdict neither marks nor applies", () => {
    const log = installConsumer({ patchable: false });
    transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
    expect(log.marked.length).toBe(0);
    expect(log.applied.length).toBe(0);
  });

  test("un-instrumented mutation skips classification entirely", () => {
    const log = installConsumer();
    transact(tab, (doc) => {
      doc.className = "custom";
    });
    expect(log.classified.length).toBe(0);
    expect(log.marked.length).toBe(0);
    expect(log.applied.length).toBe(0);
  });

  test("apply failure escalates", () => {
    const log = installConsumer({ applyThrows: true, patchable: true });
    transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
    expect(log.escalated.length).toBe(1);
    expect(log.escalated[0]).toStartWith("patch-apply-failed");
  });

  test("works without a registered consumer", () => {
    setPatchConsumer(null);
    transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
    expect(
      (
        (toRaw(tab.doc.document) as Record<string, unknown>).children as Record<string, unknown>[]
      )[0]!.style,
    ).toEqual({ color: "blue" });
  });
});

// ─── Undo/redo must carry values, not just classifications ────────────────────

describe("history replay records value-carrying ops", () => {
  test("undo posts the ops the canvas needs, not an empty patch", () => {
    // The canvas lives in an iframe and can only be patched from `record.docOps`. Recording only
    // The classification patch left this empty, so undo posted an EMPTY patch: the document
    // Changed, the patch classified as applicable (suppressing the full render), and the canvas
    // Silently kept showing the pre-undo content.
    const log = installConsumer();
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "edited"));
    log.appliedDocOps.length = 0;

    undo(tab);

    expect(log.appliedDocOps).toHaveLength(1);
    expect(log.appliedDocOps[0]).toEqual([
      { key: "textContent", op: "set-key", path: ["children", 0], value: "hello" },
    ]);
  });

  test("redo carries values too", () => {
    const log = installConsumer();
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "edited"));
    undo(tab);
    log.appliedDocOps.length = 0;

    redo(tab);

    expect(log.appliedDocOps[0]).toEqual([
      { key: "textContent", op: "set-key", path: ["children", 0], value: "edited" },
    ]);
  });

  test("undoing a structural change carries the reinserted node", () => {
    const log = installConsumer();
    transactDoc(tab, (t) => mutateRemoveNode(t, ["children", 1]));
    log.appliedDocOps.length = 0;

    undo(tab);

    const [op] = log.appliedDocOps[0] as { op: string; index: number; node: unknown }[];
    expect(op!.op).toBe("insert-child");
    expect(op!.index).toBe(1);
    // Without the node itself the canvas could not re-render the restored block.
    expect(op!.node).toMatchObject({ tagName: "span", textContent: "world" });
  });
});
