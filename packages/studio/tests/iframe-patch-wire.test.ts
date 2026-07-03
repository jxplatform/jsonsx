/**
 * Cross-frame patch wire format (D5) — proves the parent posts VALUE-CARRYING forward ops across
 * the iframe boundary, not the path-only `JxPatchOp`s. The iframe has no access to the parent's
 * reactive document, so a path-only op would be unappliable there; the recorded `docOps[].forward`
 * carry the set value / inserted node so the iframe can fold them into its shadow doc. The host
 * bridge itself is mocked so we can capture exactly what `applyPatchBatch` hands off.
 */
import "./with-dom.js";
import { describe, expect, mock, test } from "bun:test";
import type { TransactionRecord } from "../src/tabs/patch-ops";
import type { Tab } from "../src/tabs/tab";
import type { WireDocOp } from "../src/canvas/iframe-protocol";

// Capture what the parent posts to the bridge instead of reaching a real (cross-origin) iframe host.
let captured: { forwardOps: WireDocOp[]; gen: number } | null = null;
void mock.module("../src/canvas/iframe-host", () => ({
  postPatchToHosts: (forwardOps: WireDocOp[], gen: number) => {
    captured = { forwardOps, gen };
    return 1; // Pretend one ready host received it.
  },
  setIframePatchEscalation: () => {},
}));

const { applyPatchBatch } = await import("../src/canvas/canvas-patcher");

describe("parent → iframe patch wire format", () => {
  test("posts value-carrying forward ops — the values cross, not just paths", () => {
    captured = null;
    const record: TransactionRecord = {
      docOps: [
        {
          forward: { key: "style", op: "set-key", path: ["children", 0], value: { color: "blue" } },
          inverse: { key: "style", op: "set-key", path: ["children", 0], value: { color: "red" } },
        },
        {
          forward: {
            index: 1,
            node: { tagName: "b", textContent: "hi" },
            op: "insert-child",
            parentPath: [],
          },
          inverse: { index: 1, op: "remove-child", parentPath: [] },
        },
      ],
      invertible: true,
      ops: [
        { op: "set-style", path: ["children", 0] },
        { index: 1, op: "insert", parentPath: [] },
      ],
    };

    applyPatchBatch({} as Tab, record.ops, record);

    expect(captured).not.toBeNull();
    // The bridge receives the forward (value-carrying) ops, NOT the path-only `record.ops`.
    expect(captured!.forwardOps).toEqual([
      { key: "style", op: "set-key", path: ["children", 0], value: { color: "blue" } },
      { index: 1, node: { tagName: "b", textContent: "hi" }, op: "insert-child", parentPath: [] },
    ]);
    // Concretely: a path-only consumer could not reconstruct these — the set value and inserted node
    // Are present on the wire.
    expect((captured!.forwardOps[0] as { value: unknown }).value).toEqual({ color: "blue" });
    expect((captured!.forwardOps[1] as { node: unknown }).node).toEqual({
      tagName: "b",
      textContent: "hi",
    });
    expect(typeof captured!.gen).toBe("number");
  });

  test("posts an empty op list when the transaction recorded no docOps", () => {
    captured = null;
    applyPatchBatch({} as Tab, [{ op: "set-text", path: ["children", 0] }], {
      docOps: [],
      invertible: true,
      ops: [{ op: "set-text", path: ["children", 0] }],
    });
    expect(captured!.forwardOps).toEqual([]);
  });
});
