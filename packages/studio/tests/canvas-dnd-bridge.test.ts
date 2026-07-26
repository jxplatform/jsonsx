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
// The native-drag-enter handler the bridge installs via setNativeDragEnterHandler.
let nativeEnterHandler: ((host: AnyRec) => void) | null = null;
// The session sawIframeDragOver reports as iframe-driven (-1 = none; set to a seq to simulate the
// Native over/drop stream having been routed to the iframe).
let iframeDroveSeq = -1;

void mock.module("../src/canvas/iframe-host", () => ({
  adoptDragSession: (host: AnyRec, src: AnyRec, srcData: AnyRec, seq: number) => {
    dragSeq = seq;
    calls.push({ fn: "adopt", host, seq, src, srcData });
    return seq;
  },
  beginDragSession: (host: AnyRec, src: AnyRec, srcData: AnyRec) => {
    dragSeq += 1;
    calls.push({ fn: "begin", host, seq: dragSeq, src, srcData });
    return dragSeq;
  },
  clearDropIndicator: (host: AnyRec) => calls.push({ fn: "clearIndicator", host }),
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
  sawIframeDragOver: (seq: number) => seq === iframeDroveSeq,
  setNativeDragEnterHandler: (fn: (host: AnyRec) => void) => {
    nativeEnterHandler = fn;
  },
}));

// The drag-ghost module touches document.body; record show/move/clear without asserting DOM here
// (the DOM placement is covered by the drag-ghost unit test).
void mock.module("../src/panels/drag-ghost", () => ({
  clearDragGhost: () => calls.push({ fn: "ghostClear" }),
  moveDragGhost: (x: number, y: number) => calls.push({ fn: "ghostMove", x, y }),
  setDragGhost: (label: string, x: number, y: number) =>
    calls.push({ fn: "ghostShow", label, x, y }),
}));

const { buildDragMessages, isCancelDrop, registerCanvasDndBridge } =
  await import("../src/panels/canvas-dnd-bridge");

/** A pragmatic monitor location with the cursor at (clientX, clientY). */
const loc = (x: number, y: number) => ({ current: { input: { clientX: x, clientY: y } } });

beforeEach(() => {
  monitors.length = 0;
  calls.length = 0;
  hostAt = fakeHost;
  dragSeq = 5;
  nativeEnterHandler = null;
  iframeDroveSeq = -1;
  registerCanvasDndBridge();
});

/** Drive a full parent-source drag: start over fakeHost, then return the captured monitor. */
const m = () => monitors[0]!;

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

  test("onDragStart begins a session for a tree-node source, retaining its path", () => {
    const src = { path: ["children", 0], type: "tree-node" };
    monitors[0]!.onDragStart({ location: loc(300, 250), source: { data: src } });
    const begin = calls.find((c) => c.fn === "begin");
    expect(begin).toBeTruthy();
    expect(begin!.src).toEqual({ path: ["children", 0], type: "tree-node" });
    expect(begin!.srcData).toBe(src);
  });

  test("onDragStart ignores a tree-node source missing a path (e.g. an unselected handle)", () => {
    monitors[0]!.onDragStart({
      location: loc(300, 250),
      source: { data: { type: "tree-node" } },
    });
    expect(calls.find((c) => c.fn === "begin")).toBeUndefined();
  });

  test("onDragStart ignores unrelated sources (no recognized type)", () => {
    monitors[0]!.onDragStart({
      location: loc(300, 250),
      source: { data: { type: "something-else" } },
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

  test("onDrag crossing OUT of the bound canvas posts dragEnd to the old host, then no move", () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    hostAt = null;
    calls.length = 0;
    m().onDrag({ location: loc(5, 5), source: { data: { type: "block" } } });
    // Inside→outside transition: dragEnd to the previously-bound host, no dragMove.
    const ended = calls.find((c) => c.fn === "post" && c.msg.kind === "dragEnd");
    expect(ended!.host).toBe(fakeHost);
    expect(calls.find((c) => c.fn === "post" && c.msg.kind === "dragMove")).toBeUndefined();
  });

  test("onDrop posts a drop to the host at the DROP cursor", () => {
    monitors[0]!.onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    monitors[0]!.onDrop({ location: loc(300, 250), source: { data: { type: "block" } } });
    const post = calls.find((c) => c.fn === "post" && c.msg.kind === "drop");
    expect(post!.host).toBe(fakeHost);
    expect(post!.msg.cursor).toEqual({ x: 100, y: 100 });
  });

  test("onDrop off every canvas releases the retained source data (dragEnd old, no drop)", () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    hostAt = null;
    calls.length = 0;
    m().onDrop({ location: loc(5, 5), source: { data: { type: "block" } } });
    expect(calls.find((c) => c.fn === "post" && c.msg.kind === "drop")).toBeUndefined();
    expect(calls.find((c) => c.fn === "end")).toBeTruthy();
    expect(calls.find((c) => c.fn === "ghostClear")).toBeTruthy();
  });

  test("onDrop posts a drop for a tree-node source (a move)", () => {
    monitors[0]!.onDragStart({
      location: loc(300, 250),
      source: { data: { path: ["children", 1], type: "tree-node" } },
    });
    calls.length = 0;
    monitors[0]!.onDrop({
      location: loc(300, 250),
      source: { data: { path: ["children", 1], type: "tree-node" } },
    });
    const post = calls.find((c) => c.fn === "post" && c.msg.kind === "drop");
    expect(post!.host).toBe(fakeHost);
  });

  test("onDrop ignores unrecognized sources", () => {
    monitors[0]!.onDrop({
      location: loc(300, 250),
      source: { data: { type: "something-else" } },
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

  test("onDragStart shows the ghost with the block fragment's tag label", () => {
    m().onDragStart({
      location: loc(300, 250),
      source: { data: { fragment: { tagName: "section" }, type: "block" } },
    });
    const show = calls.find((c) => c.fn === "ghostShow");
    expect(show!.label).toBe("section");
    expect({ x: show!.x, y: show!.y }).toEqual({ x: 300, y: 250 });
  });

  test("onDrag moves the ghost to the raw cursor 1:1 (not the converted iframe coord)", () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    m().onDrag({ location: loc(321, 222), source: { data: { type: "block" } } });
    const moved = calls.find((c) => c.fn === "ghostMove");
    expect({ x: moved!.x, y: moved!.y }).toEqual({ x: 321, y: 222 });
  });

  test("MIGRATION: onDrag crossing into a DIFFERENT panel dragEnds old + dragStarts new", () => {
    const hostA = { id: "A" } as unknown as AnyRec;
    const hostB = { id: "B" } as unknown as AnyRec;
    hostAt = hostA;
    m().onDragStart({ location: loc(150, 60), source: { data: { type: "block" } } });
    hostAt = hostB;
    calls.length = 0;
    m().onDrag({ location: loc(900, 60), source: { data: { type: "block" } } });
    const ended = calls.find((c) => c.fn === "post" && c.msg.kind === "dragEnd");
    const begun = calls.find((c) => c.fn === "begin");
    expect(ended!.host).toBe(hostA);
    expect(begun!.host).toBe(hostB);
    // A dragMove to the NEW host follows the migration so the new iframe drives the preview.
    const moved = calls.find((c) => c.fn === "post" && c.msg.kind === "dragMove");
    expect(moved!.host).toBe(hostB);
  });

  test("CANCEL (Escape snap-back): onDrop with current==initial tears down without a drop", () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    // Pragmatic resets current to initial on cancel → equal coords.
    m().onDrop({
      location: {
        current: { input: { clientX: 9, clientY: 9 } },
        initial: { input: { clientX: 9, clientY: 9 } },
      },
      source: { data: { type: "block" } },
    });
    expect(calls.find((c) => c.fn === "post" && c.msg.kind === "drop")).toBeUndefined();
    expect(calls.find((c) => c.fn === "post" && c.msg.kind === "dragEnd")).toBeTruthy();
    expect(calls.find((c) => c.fn === "ghostClear")).toBeTruthy();
  });

  test("TIMEOUT fallback: no dropResult within the window clears ghost + indicator", async () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    m().onDrop({ location: loc(300, 250), source: { data: { type: "block" } } });
    // The drop was posted; the iframe never replies, so after the timeout the affordances clear.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(calls.find((c) => c.fn === "ghostClear")).toBeTruthy();
    expect(calls.find((c) => c.fn === "clearIndicator")).toBeTruthy();
  });
});

describe("nativeDragEnter — native stream entered an unclaimed iframe", () => {
  test("binds the pending drag when the parent never bound a host (palette → canvas jump)", () => {
    // The drag starts off every canvas: no session, but the source is retained as pending.
    hostAt = null;
    m().onDragStart({ location: loc(5, 5), source: { data: { type: "block" } } });
    expect(calls.find((c) => c.fn === "begin")).toBeUndefined();
    calls.length = 0;
    // The cursor crossed onto the iframe unseen; the iframe announces it.
    nativeEnterHandler!(fakeHost);
    const begin = calls.find((c) => c.fn === "begin");
    expect(begin!.host).toBe(fakeHost);
    expect(begin!.src).toEqual({ type: "block" });
  });

  test("migrates a session bound to another panel (dragEnd old + dragStart new)", () => {
    const hostA = { id: "A" } as unknown as AnyRec;
    const hostB = { id: "B" } as unknown as AnyRec;
    hostAt = hostA;
    m().onDragStart({ location: loc(150, 60), source: { data: { type: "block" } } });
    calls.length = 0;
    nativeEnterHandler!(hostB);
    const ended = calls.find((c) => c.fn === "post" && c.msg.kind === "dragEnd");
    expect(ended!.host).toBe(hostA);
    const begun = calls.find((c) => c.fn === "begin");
    expect(begun!.host).toBe(hostB);
  });

  test("is a no-op when already bound to that host (dragStart already posted)", () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    nativeEnterHandler!(fakeHost);
    expect(calls).toHaveLength(0);
  });

  test("is a no-op with no parent drag in flight (e.g. an OS file drag)", () => {
    nativeEnterHandler!(fakeHost);
    expect(calls).toHaveLength(0);
  });

  test("is a no-op after the drag ended (pending cleared in onDrop)", () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    m().onDrop({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    nativeEnterHandler!(fakeHost);
    expect(calls).toHaveLength(0);
  });
});

describe("iframe-driven drop (native routing) — onDrop defers to the in-flight dropResult", () => {
  test("skips cancel/drop even on a snap-back location and keeps the retained srcData", () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    // The begin bumped the mock seq to 6; mark the iframe as having driven that session.
    iframeDroveSeq = 6;
    calls.length = 0;
    // Pragmatic saw no dragover over the iframe, so current snapped back to initial (a false
    // Cancel) — the bridge must trust the iframe's in-flight dropResult instead.
    m().onDrop({
      location: {
        current: { input: { clientX: 9, clientY: 9 } },
        initial: { input: { clientX: 9, clientY: 9 } },
      },
      source: { data: { type: "block" } },
    });
    expect(calls.find((c) => c.fn === "post")).toBeUndefined();
    expect(calls.find((c) => c.fn === "end")).toBeUndefined();
    expect(calls.find((c) => c.fn === "ghostClear")).toBeUndefined();
  });

  test("falls back to a full teardown when no dropResult ever arrives (Escape over the iframe)", async () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    iframeDroveSeq = 6;
    calls.length = 0;
    m().onDrop({ location: loc(300, 250), source: { data: { type: "block" } } });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    const ended = calls.find((c) => c.fn === "post" && c.msg.kind === "dragEnd");
    expect(ended!.host).toBe(fakeHost);
    expect(calls.find((c) => c.fn === "end")).toBeTruthy();
    expect(calls.find((c) => c.fn === "ghostClear")).toBeTruthy();
    expect(calls.find((c) => c.fn === "clearIndicator")).toBeTruthy();
  });

  test("the fallback no-ops when a NEW session started before the window elapsed", async () => {
    m().onDragStart({ location: loc(300, 250), source: { data: { type: "block" } } });
    iframeDroveSeq = 6;
    m().onDrop({ location: loc(300, 250), source: { data: { type: "block" } } });
    calls.length = 0;
    // A new drag began (the mock's currentDragSession now reports a different seq).
    dragSeq = 99;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(calls.find((c) => c.fn === "post" && c.msg.kind === "dragEnd")).toBeUndefined();
    expect(calls.find((c) => c.fn === "end")).toBeUndefined();
  });
});

describe("isCancelDrop (pure)", () => {
  test("no initial → not a cancel", () => {
    expect(isCancelDrop(loc(10, 10))).toBe(false);
  });
  test("current==initial → cancel", () => {
    expect(
      isCancelDrop({
        current: { input: { clientX: 5, clientY: 6 } },
        initial: { input: { clientX: 5, clientY: 6 } },
      }),
    ).toBe(true);
  });
  test("current!=initial → real drop", () => {
    expect(
      isCancelDrop({
        current: { input: { clientX: 5, clientY: 6 } },
        initial: { input: { clientX: 5, clientY: 99 } },
      }),
    ).toBe(false);
  });
});
