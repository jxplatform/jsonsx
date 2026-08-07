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
/** How many ready hosts the fake bridge reports having fanned the patch out to. */
let readyHosts = 1;
void mock.module("../src/canvas/iframe-host", () => ({
  postPatchToHosts: (forwardOps: WireDocOp[], gen: number) => {
    captured = { forwardOps, gen };
    return readyHosts;
  },
  setIframePatchEscalation: () => {},
}));

const { applyPatchBatch } = await import("../src/canvas/canvas-patcher");
const { canvasPerf, resetCanvasPerf } = await import("../src/canvas/canvas-perf");
const { closeAllTabs, openTab } = await import("../src/workspace/workspace");

/**
 * A tab some pane is actually SHOWING.
 *
 * `{} as Tab` used to be enough, because the patch was posted with "the canvas's" generation. It is
 * posted with the generation of the surface displaying the tab now (`surfaceShowingTab`), and a tab
 * no pane holds has no host to post to — which is the correct answer and the reason the cast
 * stopped working. The fixture has to put the tab somewhere.
 */
function showingTab(): Tab {
  closeAllTabs();
  return openTab({ document: { tagName: "div" }, documentPath: "/p/index.json", id: "wire-tab" });
}

describe("parent → iframe patch wire format", () => {
  test("posts value-carrying forward ops — the values cross, not just paths", () => {
    captured = null;
    const tab = showingTab();
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
      fmOps: [],
      invertible: true,
      ops: [
        { op: "set-style", path: ["children", 0] },
        { index: 1, op: "insert", parentPath: [] },
      ],
    };

    applyPatchBatch(tab, record.ops, record);

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
    applyPatchBatch(showingTab(), [{ op: "set-text", path: ["children", 0] }], {
      docOps: [],
      fmOps: [],
      invertible: true,
      ops: [{ op: "set-text", path: ["children", 0] }],
    });
    expect(captured!.forwardOps).toEqual([]);
  });

  test("a patch counts once however many artboards it reaches", () => {
    // `patchedOps` versus `escalations` is how much of a session avoided a render at all, so it
    // Must count MUTATIONS. Counting the fan-out would make a six-breakpoint canvas look six times
    // Busier than a single-artboard one for exactly the same edit.
    resetCanvasPerf();
    const tab = showingTab();
    const batch = (): [Tab, TransactionRecord["ops"], TransactionRecord] => [
      tab,
      [{ op: "set-text", path: ["children", 0] }],
      {
        docOps: [
          {
            forward: { key: "textContent", op: "set-key", path: ["children", 0], value: "X" },
            inverse: { key: "textContent", op: "set-key", path: ["children", 0], value: "y" },
          },
        ],
        fmOps: [],
        invertible: true,
        ops: [{ op: "set-text", path: ["children", 0] }],
      },
    ];

    readyHosts = 1;
    applyPatchBatch(...batch());
    expect(canvasPerf.patchedOps).toBe(1);

    readyHosts = 6;
    applyPatchBatch(...batch());
    expect(canvasPerf.patchedOps).toBe(2);

    // No host could take it: the batch escalates, and nothing is recorded as patched.
    readyHosts = 0;
    expect(() => applyPatchBatch(...batch())).toThrow(/no-ready-iframe-host/);
    expect(canvasPerf.patchedOps).toBe(2);
    readyHosts = 1;
  });
});
