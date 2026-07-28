/**
 * Granular merge — the capability this schema exists for.
 *
 * Before: every non-`children` key was a whole-JSON LWW value, so two authors typing in one
 * paragraph (or setting different CSS properties on one element) produced concurrent whole-value
 * writes and one of them was simply discarded. Character granularity existed only on `source`,
 * which the canvas does not edit.
 *
 * These tests drive TWO replicas through the real op bridge — the same path Studio's transaction
 * mirror takes — and assert both edits survive.
 */
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { applyDocOpsToY, LOCAL_ORIGIN, yEventsToDocOps } from "../src/op-bridge.ts";
import { seedStructure, structureMap, yDocToJson } from "../src/schema.ts";
import { applyDocOpToDoc } from "../src/ops.ts";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxDocOp } from "../src/ops.ts";

/** Two replicas seeded from the same document, wired to exchange updates on demand. */
function pair(document: JxMutableNode) {
  const a = new Y.Doc();
  seedStructure(a, document);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return {
    a,
    b,
    /** Exchange both ways until convergence (one round is enough for a single concurrent pair). */
    sync() {
      const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
      const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
      Y.applyUpdate(b, fromA);
      Y.applyUpdate(a, fromB);
    },
  };
}

const PARAGRAPH: JxMutableNode = {
  children: [{ style: { color: "red" }, tagName: "p", textContent: "Hello world" }],
  tagName: "div",
};

describe("concurrent text edits in one paragraph", () => {
  test("both authors' characters survive — no whole-paragraph clobber", () => {
    const { a, b, sync } = pair(PARAGRAPH);
    const path = ["children", 0];

    // A types " dear" after "Hello"; B appends "!" — each commits the WHOLE textContent, exactly as
    // An inline-edit commit does.
    applyDocOpsToY(
      a,
      [{ key: "textContent", op: "set-key", path, value: "Hello dear world" }],
      LOCAL_ORIGIN,
    );
    applyDocOpsToY(
      b,
      [{ key: "textContent", op: "set-key", path, value: "Hello world!" }],
      LOCAL_ORIGIN,
    );

    sync();

    const textA = (yDocToJson(a).children as JxMutableNode[])[0]!.textContent as string;
    const textB = (yDocToJson(b).children as JxMutableNode[])[0]!.textContent as string;
    expect(textA).toBe(textB); // Converged.
    expect(textA).toContain("dear"); // A's insertion survived.
    expect(textA.endsWith("!")).toBe(true); // B's survived too.
  });

  test("the Y.Text node keeps its identity across a whole-value commit", () => {
    const { a } = pair(PARAGRAPH);
    const node = structureMap(a).get("children") as Y.Array<unknown>;
    const paragraph = node.get(0) as Y.Map<unknown>;
    const before = paragraph.get("textContent");
    applyDocOpsToY(
      a,
      [{ key: "textContent", op: "set-key", path: ["children", 0], value: "Hello there world" }],
      LOCAL_ORIGIN,
    );
    // Same Y.Text instance, edited in place. A fresh one would orphan every concurrent insert.
    expect(paragraph.get("textContent")).toBe(before);
    expect((paragraph.get("textContent") as Y.Text).toString()).toBe("Hello there world");
  });

  test("a bare-string child merges per character too", () => {
    const { a, b, sync } = pair({ children: ["shared text"], tagName: "p" });
    applyDocOpsToY(
      a,
      [{ index: 0, node: "shared prose text", op: "set-child", parentPath: [] }],
      LOCAL_ORIGIN,
    );
    applyDocOpsToY(
      b,
      [{ index: 0, node: "shared text here", op: "set-child", parentPath: [] }],
      LOCAL_ORIGIN,
    );
    sync();
    const textA = (yDocToJson(a).children as string[])[0]!;
    expect(textA).toBe((yDocToJson(b).children as string[])[0]!);
    expect(textA).toContain("prose");
    expect(textA).toContain("here");
  });

  test("switching text to a $ref replaces wholesale (no shared structure to preserve)", () => {
    const { a } = pair(PARAGRAPH);
    applyDocOpsToY(
      a,
      [
        {
          key: "textContent",
          op: "set-key",
          path: ["children", 0],
          value: { $ref: "#/state/title" },
        },
      ],
      LOCAL_ORIGIN,
    );
    const paragraph = (structureMap(a).get("children") as Y.Array<unknown>).get(
      0,
    ) as Y.Map<unknown>;
    expect(paragraph.get("textContent")).not.toBeInstanceOf(Y.Text);
    expect(yValueOf(a)).toEqual({ $ref: "#/state/title" });
  });
});

function yValueOf(doc: Y.Doc) {
  return (yDocToJson(doc).children as JxMutableNode[])[0]!.textContent;
}

describe("concurrent style edits on one element", () => {
  test("different properties both survive", () => {
    const { a, b, sync } = pair(PARAGRAPH);
    const path = ["children", 0];
    // Both mutators write the WHOLE style object, which is what mutateUpdateStyle records.
    applyDocOpsToY(
      a,
      [{ key: "style", op: "set-key", path, value: { color: "blue" } }],
      LOCAL_ORIGIN,
    );
    applyDocOpsToY(
      b,
      [{ key: "style", op: "set-key", path, value: { color: "red", padding: "4px" } }],
      LOCAL_ORIGIN,
    );
    sync();
    const styleA = (yDocToJson(a).children as JxMutableNode[])[0]!.style as Record<string, string>;
    expect(styleA).toEqual(
      (yDocToJson(b).children as JxMutableNode[])[0]!.style as Record<string, string>,
    );
    expect(styleA.padding).toBe("4px"); // B's new property survived A's write.
    expect(styleA.color).toBe("blue"); // And the contended one converged.
  });

  test("a removed property is a real delete, not a stale leftover", () => {
    const { a } = pair(PARAGRAPH);
    applyDocOpsToY(
      a,
      [{ key: "style", op: "set-key", path: ["children", 0], value: { padding: "4px" } }],
      LOCAL_ORIGIN,
    );
    const style = (yDocToJson(a).children as JxMutableNode[])[0]!.style as Record<string, string>;
    expect(style).toEqual({ padding: "4px" });
  });

  test("nested media and pseudo blocks merge per property as well", () => {
    const { a, b, sync } = pair({
      children: [{ style: { "@--sm": { margin: "0" } }, tagName: "p" }],
      tagName: "div",
    });
    const path = ["children", 0];
    applyDocOpsToY(
      a,
      [{ key: "style", op: "set-key", path, value: { "@--sm": { margin: "0", padding: "1px" } } }],
      LOCAL_ORIGIN,
    );
    applyDocOpsToY(
      b,
      [
        {
          key: "style",
          op: "set-key",
          path,
          value: { "&:hover": { color: "red" }, "@--sm": { margin: "0" } },
        },
      ],
      LOCAL_ORIGIN,
    );
    sync();
    const styleA = (yDocToJson(a).children as JxMutableNode[])[0]!.style as Record<
      string,
      Record<string, string>
    >;
    expect(styleA).toEqual(
      (yDocToJson(b).children as JxMutableNode[])[0]!.style as Record<
        string,
        Record<string, string>
      >,
    );
    expect(styleA["@--sm"]!.padding).toBe("1px");
    expect(styleA["&:hover"]!.color).toBe("red");
  });
});

describe("inbound events collapse back to whole-value ops", () => {
  /** Capture the ops a remote transaction produces, the way collab-session does. */
  function opsFromRemote(doc: Y.Doc, mutate: () => void): JxDocOp[] | null {
    let captured: JxDocOp[] | null = null;
    const observer = (events: Y.YEvent<never>[]) => {
      captured = yEventsToDocOps(events);
    };
    type DeepObserver = Parameters<Y.Map<unknown>["observeDeep"]>[0];
    structureMap(doc).observeDeep(observer as unknown as DeepObserver);
    mutate();
    structureMap(doc).unobserveDeep(observer as unknown as DeepObserver);
    return captured;
  }

  test("a remote character insert becomes one whole-value set-key", () => {
    const { a, b, sync } = pair(PARAGRAPH);
    applyDocOpsToY(
      a,
      [{ key: "textContent", op: "set-key", path: ["children", 0], value: "Hello brave world" }],
      LOCAL_ORIGIN,
    );
    const update = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const ops = opsFromRemote(b, () => Y.applyUpdate(b, update));
    expect(ops).toEqual([
      { key: "textContent", op: "set-key", path: ["children", 0], value: "Hello brave world" },
    ]);
    sync();
  });

  test("a remote style property change becomes one whole-value set-key for the object", () => {
    const { a, b } = pair(PARAGRAPH);
    applyDocOpsToY(
      a,
      [
        {
          key: "style",
          op: "set-key",
          path: ["children", 0],
          value: { color: "red", padding: "8px" },
        },
      ],
      LOCAL_ORIGIN,
    );
    const update = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const ops = opsFromRemote(b, () => Y.applyUpdate(b, update));
    expect(ops).toEqual([
      {
        key: "style",
        op: "set-key",
        path: ["children", 0],
        value: { color: "red", padding: "8px" },
      },
    ]);
  });

  test("those ops replay onto a plain document tree unchanged", () => {
    // The op log stays whole-value, so the SAME applier the canvas and history use still works.
    const { a, b } = pair(PARAGRAPH);
    applyDocOpsToY(
      a,
      [{ key: "textContent", op: "set-key", path: ["children", 0], value: "Replayed" }],
      LOCAL_ORIGIN,
    );
    const update = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const ops = opsFromRemote(b, () => Y.applyUpdate(b, update))!;
    const plain = structuredClone(PARAGRAPH);
    for (const op of ops) {
      applyDocOpToDoc(plain, op);
    }
    expect((plain.children as JxMutableNode[])[0]!.textContent).toBe("Replayed");
  });
});

describe("undo keeps a peer's concurrent edit", () => {
  test("A's undo of its own style write does not destroy B's sibling property", () => {
    const { a, b, sync } = pair(PARAGRAPH);
    const path = ["children", 0];
    const undo = new Y.UndoManager(structureMap(a), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    });

    applyDocOpsToY(
      a,
      [{ key: "style", op: "set-key", path, value: { color: "blue" } }],
      LOCAL_ORIGIN,
    );
    sync();
    applyDocOpsToY(
      b,
      [{ key: "style", op: "set-key", path, value: { color: "blue", padding: "4px" } }],
      LOCAL_ORIGIN,
    );
    sync();

    undo.undo();
    sync();

    const styleA = (yDocToJson(a).children as JxMutableNode[])[0]!.style as Record<string, string>;
    expect(styleA).toEqual(
      (yDocToJson(b).children as JxMutableNode[])[0]!.style as Record<string, string>,
    );
    // A's undo reverts A's own colour change; B's padding is untouched. Origin-scoped undo is the
    // Reason this holds, and it is why the Y.UndoManager delegate stays.
    expect(styleA.color).toBe("red");
    expect(styleA.padding).toBe("4px");
  });
});
