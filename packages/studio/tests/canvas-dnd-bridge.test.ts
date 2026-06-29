/**
 * Tests for src/panels/canvas-dnd-bridge.ts — the cross-frame DnD coordinator (Phase 4c spike).
 *
 * Pragmatic's monitor is mocked to capture the registered callbacks so they can be driven with
 * synthetic locations; the iframe-host session API is mocked so the test asserts WHICH session
 * calls fire (begin/move/drop) and with what arguments, without a live iframe. The PURE
 * buildDragMessages is tested directly (no mocks needed for the math).
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type AnyRec = Record<string, any>;

const monitors: AnyRec[] = [];
void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  monitorForElements: (cfg: AnyRec) => {
    monitors.push(cfg);
    return () => {};
  },
}));

// A fake host object (opaque to the bridge) + a recording of the session API calls.
const fakeHost = { id: "host" } as unknown as AnyRec;
const calls: AnyRec[] = [];
let hostAt: AnyRec | null = fakeHost;
let dragSeq = 5;

void mock.module("../src/canvas/iframe-host", () => ({
  beginDragSession: (host: AnyRec, src: AnyRec, srcData: AnyRec) => {
    calls.push({ fn: "begin", host, src, srcData });
    dragSeq += 1;
    return dragSeq;
  },
  currentDragSession: () => dragSeq,
  endDragSession: (seq: number) => calls.push({ fn: "end", seq }),
  hostDragGeometry: (host: AnyRec) => {
    calls.push({ fn: "geo", host });
    return { rect: { left: 100, top: 50 }, scale: 2 };
  },
  liveDragHostAt: (cursor: AnyRec) => {
    calls.push({ cursor, fn: "hostAt" });
    return hostAt;
  },
  postDragMessage: (host: AnyRec, msg: AnyRec) => calls.push({ fn: "post", host, msg }),
}));

const { buildDragMessages, registerCanvasDndBridge } =
  await import("../src/panels/canvas-dnd-bridge");

/** A pragmatic monitor location with the cursor at (clientX, clientY). */
const loc = (x: number, y: number) => ({ current: { input: { clientX: x, clientY: y } } });

beforeEach(() => {
  monitors.length = 0;
  calls.length = 0;
  hostAt = fakeHost;
  dragSeq = 5;
  registerCanvasDndBridge();
});

afterEach(() => {
  monitors.length = 0;
});

describe("buildDragMessages (pure)", () => {
  test("converts the cursor by parentCursorToIframe and tags both legs with the seq", () => {
    // Cursor (300,250) over an iframe at (100,50), scale 2 → ((300-100)/2, (250-50)/2) = (100,100).
    const { move, drop } = buildDragMessages({ x: 300, y: 250 }, 7, 2, { left: 100, top: 50 });
    expect(move).toEqual({ cursor: { x: 100, y: 100 }, dragSeq: 7, kind: "dragMove" });
    expect(drop).toEqual({ cursor: { x: 100, y: 100 }, dragSeq: 7, kind: "drop" });
  });

  test("move and drop share the exact same converted cursor (no divergent transform)", () => {
    const { move, drop } = buildDragMessages({ x: 10, y: 10 }, 1, 0.5, { left: 0, top: 0 });
    expect((move as AnyRec).cursor).toEqual((drop as AnyRec).cursor);
  });
});

describe("registerCanvasDndBridge — coordinator", () => {
  test("registers exactly one monitor", () => {
    expect(monitors).toHaveLength(1);
  });

  test("onDragStart begins a session for a palette block source at the cursor's host", () => {
    const src = { fragment: { tagName: "hr" }, type: "block" };
    monitors[0]!.onDragStart({ location: loc(300, 250), source: { data: src } });
    const begin = calls.find((c) => c.fn === "begin");
    expect(begin).toBeTruthy();
    expect(begin!.src).toEqual({ type: "block" });
    expect(begin!.srcData).toBe(src); // The full fragment is retained (never crosses the wire).
  });

  test("onDragStart ignores non-block (tree-node) sources this slice", () => {
    monitors[0]!.onDragStart({
      location: loc(300, 250),
      source: { data: { path: ["children", 0], type: "tree-node" } },
    });
    expect(calls.find((c) => c.fn === "begin")).toBeUndefined();
  });

  test("onDrag posts a dragMove (converted cursor) to the host under the cursor", () => {
    monitors[0]!.onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    monitors[0]!.onDrag({ location: loc(300, 250), source: { data: { type: "block" } } });
    const post = calls.find((c) => c.fn === "post");
    expect(post!.host).toBe(fakeHost);
    expect(post!.msg.kind).toBe("dragMove");
    // (300-100)/2, (250-50)/2 = 100,100 (scale 2, rect left100/top50 from the mock geometry).
    expect(post!.msg.cursor).toEqual({ x: 100, y: 100 });
  });

  test("onDrag over no host posts nothing", () => {
    monitors[0]!.onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    hostAt = null;
    calls.length = 0;
    monitors[0]!.onDrag({ location: loc(5, 5), source: { data: { type: "block" } } });
    expect(calls.find((c) => c.fn === "post")).toBeUndefined();
  });

  test("onDrop posts a drop to the host at the DROP cursor", () => {
    monitors[0]!.onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    monitors[0]!.onDrop({ location: loc(300, 250), source: { data: { type: "block" } } });
    const post = calls.find((c) => c.fn === "post" && c.msg.kind === "drop");
    expect(post!.host).toBe(fakeHost);
    expect(post!.msg.cursor).toEqual({ x: 100, y: 100 });
  });

  test("onDrop off every canvas releases the retained source data (no post)", () => {
    monitors[0]!.onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    hostAt = null;
    calls.length = 0;
    monitors[0]!.onDrop({ location: loc(5, 5), source: { data: { type: "block" } } });
    expect(calls.find((c) => c.fn === "post")).toBeUndefined();
    expect(calls.find((c) => c.fn === "end")).toBeTruthy();
  });

  test("onDrop ignores non-block sources", () => {
    monitors[0]!.onDrop({
      location: loc(300, 250),
      source: { data: { path: [], type: "tree-node" } },
    });
    expect(calls).toHaveLength(0);
  });

  test("multi-panel: the cursor's panel owns the drop (host resolved by cursor, not active panel)", () => {
    const hostA = { id: "A" } as unknown as AnyRec;
    const hostB = { id: "B" } as unknown as AnyRec;
    // Start over A.
    hostAt = hostA;
    monitors[0]!.onDragStart({ location: loc(150, 60), source: { data: { type: "block" } } });
    // Drop over B (a different cursor resolves to a different host).
    hostAt = hostB;
    calls.length = 0;
    monitors[0]!.onDrop({ location: loc(900, 60), source: { data: { type: "block" } } });
    const post = calls.find((c) => c.fn === "post" && c.msg.kind === "drop");
    expect(post!.host).toBe(hostB);
  });
});
