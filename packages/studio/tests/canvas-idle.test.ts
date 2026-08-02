/**
 * The canvas half of `probe.idle()`, and the point resolution that replaced a coordinate guess.
 *
 * Two questions the parent realm could not previously answer about a cross-origin canvas:
 *
 * 1. _Has it settled?_ — answered by the frame itself (`{kind: "idle"}`), folded in PER HOST so P8's
 *    second pane does not turn `shot.ts`'s "Studio's only child frame" into a coin flip.
 * 2. _Where is this node on screen?_ — answered by the host composing its own transforms, which is
 *    what deletes the caller's `Math.abs(scale - 1) < 0.001` branch.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { flush, resetWorkspaceWithTab, stubRect } from "./harness";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

interface FakeChannel {
  posts: Record<string, unknown>[];
  deliver: (m: Record<string, unknown>) => void;
}
const channels: FakeChannel[] = [];

void mock.module("../src/canvas/iframe-channel", () => ({
  postMessageChannel: (opts: Record<string, unknown>) => {
    let handler: ((m: Record<string, unknown>) => void) | null = null;
    const rec: FakeChannel = { deliver: (m) => handler?.(m), posts: [] };
    channels.push(rec);
    return {
      dispose: () => {},
      onMessage: (h: (m: Record<string, unknown>) => void) => {
        handler = h;
        return () => {};
      },
      post: (m: Record<string, unknown>) => rec.posts.push(m),
      target: opts.target,
    };
  },
}));

void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
}));

void mock.module("../src/canvas/canvas-live-render", () => ({
  resolveCanvasDocument: () =>
    Promise.resolve({
      docBase: "http://localhost:3000/doc.json",
      mapperCtx: {
        arrayPaths: [],
        canvasMode: "design",
        layoutWrapped: false,
        pageContentOffset: null,
        pageContentPrefix: null,
      },
      renderDoc: { children: ["hi"], tagName: "div" },
      siteStyle: null,
    }),
}));

const {
  MEASURE_TIMEOUT_MS,
  canvasIdleBlockers,
  canvasPointAt,
  mountIframeCanvas,
  mountStylebookCanvas,
  postPatchToHosts,
  revealCanvasPath,
} = await import("../src/canvas/iframe-host");
const { initCanvasUtils } = await import("../src/canvas/canvas-utils");
const { initShellRefs } = await import("../src/store");
const { view } = await import("../src/view");

const QUIET = { animations: 0, fonts: true, images: 0, kind: "idle" as const };

/** Mount one page host and bring it to the state a settled canvas is in. */
async function mountReadyCanvas(gen = 1): Promise<{ canvasEl: HTMLElement; channel: FakeChannel }> {
  const canvasEl = document.createElement("div");
  document.body.append(canvasEl);
  await mountIframeCanvas(gen, { tagName: "div" } as never, canvasEl);
  const channel = channels.at(-1)!;
  channel.deliver({ kind: "ready" });
  channel.deliver({ gen, kind: "renderComplete" });
  channel.deliver({ ...QUIET, gen });
  return { canvasEl, channel };
}

beforeEach(() => {
  channels.length = 0;
  // The real pan path writes `view.panY` and reads `#canvas-wrap` — stand the shell up rather than
  // Mocking canvas-utils, so `revealCanvasPath` is exercised end to end.
  document.body.innerHTML = '<div id="canvas-wrap"><div class="panzoom-wrap"></div></div>';
  initShellRefs();
  initCanvasUtils({ getCanvasMode: () => "design", getZoom: () => 1, setZoomDirect: () => {} });
  view.panzoomWrap = document.querySelector(".panzoom-wrap");
  view.panX = 0;
  view.panY = 0;
});

describe("canvasIdleBlockers", () => {
  test("no canvas at all is not a reason to wait", () => {
    expect(canvasIdleBlockers()).toEqual([]);
  });

  test("a frame that has not handshaked blocks, and says so once", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    expect(canvasIdleBlockers()).toEqual(["canvas[unbound]: frame has not handshaked"]);
  });

  test("a ready frame that has not reported quiescence is not assumed quiet", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    channels.at(-1)!.deliver({ kind: "ready" });
    channels.at(-1)!.deliver({ gen: 1, kind: "renderComplete" });
    expect(canvasIdleBlockers()).toEqual(["canvas[unbound]: no quiescence report yet"]);
  });

  test("a settled host reports nothing", async () => {
    await mountReadyCanvas();
    expect(canvasIdleBlockers()).toEqual([]);
  });

  test("an unacked render names its generation", async () => {
    const tab = resetWorkspaceWithTab(undefined, { id: "page-1" });
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(4, { tagName: "div" } as never, canvasEl, null, tab.id);
    const channel = channels.at(-1)!;
    channel.deliver({ kind: "ready" });
    expect(canvasIdleBlockers()).toEqual([
      "canvas[unbound]: gen 4 unacked",
      "canvas[unbound]: no quiescence report yet",
    ]);
    channel.deliver({ gen: 4, kind: "renderComplete" });
    channel.deliver({ ...QUIET, gen: 4 });
    // The ack adopted the tab identity, so the host now names itself by the tab it renders.
    expect(canvasIdleBlockers()).toEqual([]);
  });

  test("an unacked PATCH blocks too, and both acks release it", async () => {
    const tab = resetWorkspaceWithTab(undefined, { id: "page-2" });
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl, null, tab.id);
    const channel = channels.at(-1)!;
    channel.deliver({ kind: "ready" });
    channel.deliver({ gen: 1, kind: "renderComplete" });
    channel.deliver({ ...QUIET, gen: 1 });

    expect(postPatchToHosts([], 1, "page-2")).toBe(1);
    expect(canvasIdleBlockers()).toEqual(["canvas[page-2]: 1 unacked patch(es)"]);
    channel.deliver({ gen: 1, kind: "patchComplete" });
    expect(canvasIdleBlockers()).toEqual([]);

    // A patch that FAILS is still a patch that finished — a counter that only went up would wedge
    // Every later idle() behind a message the host already escalated past.
    expect(postPatchToHosts([], 1, "page-2")).toBe(1);
    expect(canvasIdleBlockers()).toEqual(["canvas[page-2]: 1 unacked patch(es)"]);
    channel.deliver({ gen: 1, kind: "patchError", message: "nope" });
    expect(canvasIdleBlockers()).toEqual([]);
  });

  test("the frame's own report names fonts, animations and pending image retries", async () => {
    const { channel } = await mountReadyCanvas();
    channel.deliver({ animations: 2, fonts: false, gen: 1, images: 3, kind: "idle" });
    expect(canvasIdleBlockers()).toEqual([
      "canvas[unbound]: fonts still loading",
      "canvas[unbound]: 2 running animation(s)",
      "canvas[unbound]: 3 pending image retry(ies)",
    ]);
  });

  test("a quiescence report from a superseded generation is not trusted", async () => {
    const { channel } = await mountReadyCanvas(1);
    channel.deliver({ gen: 2, kind: "renderComplete" });
    expect(canvasIdleBlockers()).toEqual([
      "canvas[unbound]: quiescence is for gen 1, DOM is gen 2",
    ]);
  });

  test("a stylebook host names itself by its role, and each host answers separately", async () => {
    const pageEl = document.createElement("div");
    const bookEl = document.createElement("div");
    document.body.append(pageEl, bookEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, pageEl);
    channels.at(-1)!.deliver({ kind: "ready" });
    channels.at(-1)!.deliver({ gen: 1, kind: "renderComplete" });
    channels.at(-1)!.deliver({ ...QUIET, gen: 1 });
    mountStylebookCanvas(
      2,
      { doc: { tagName: "div" } as never, pathToTag: new Map(), tagToCardPath: new Map() },
      bookEl,
      null,
    );
    expect(canvasIdleBlockers()).toEqual(["canvas[stylebook]: frame has not handshaked"]);
  });

  test("a disconnected host stops being asked", async () => {
    const { canvasEl, channel } = await mountReadyCanvas();
    channel.deliver({ animations: 1, fonts: true, gen: 1, images: 0, kind: "idle" });
    expect(canvasIdleBlockers()).toHaveLength(1);
    canvasEl.remove();
    expect(canvasIdleBlockers()).toEqual([]);
  });
});

describe("canvasPointAt", () => {
  test("answers null when no canvas can measure the path", async () => {
    const point = await canvasPointAt(["children", 0]);
    expect(point).toBeNull();
  });

  test("composes the iframe offset and the empirical zoom into one top-document point", async () => {
    const { canvasEl, channel } = await mountReadyCanvas();
    const iframe = canvasEl.querySelector("iframe")!;
    // A 2× panzoom transform: the element's box is twice its layout width, offset by the pan.
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 400 });
    stubRect(iframe, { height: 600, left: 100, top: 50, width: 800 });

    const pending = canvasPointAt(["children", 0]);
    const measure = channel.posts.at(-1)!;
    expect(measure).toMatchObject({ kind: "measure", paths: [["children", 0]] });
    channel.deliver({
      hits: [{ path: ["children", 0], rect: { height: 20, width: 60, x: 10, y: 30 } }],
      kind: "geometry",
      reqId: measure.reqId,
    });
    // Left = 100 + 10*2, top = 50 + 30*2, size doubled, x/y at the centre.
    const point = await pending;
    expect(point).toEqual({
      height: 40,
      left: 120,
      top: 110,
      width: 120,
      x: 180,
      y: 130,
    });
  });

  test("a path the frame cannot find answers null rather than a fabricated point", async () => {
    const { channel } = await mountReadyCanvas();
    const pending = canvasPointAt(["children", 9]);
    const { reqId } = channel.posts.at(-1)!;
    channel.deliver({ hits: [], kind: "geometry", reqId });
    const point = await pending;
    expect(point).toBeNull();
  });

  test("a measure that never comes back times out instead of hanging the caller", async () => {
    const { channel } = await mountReadyCanvas();
    const pending = canvasPointAt(["children", 0]);
    expect(canvasIdleBlockers()).toEqual(["canvas[unbound]: 1 measure(s) in flight"]);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, MEASURE_TIMEOUT_MS + 20);
    });
    const timedOut = await pending;
    expect(timedOut).toBeNull();
    expect(canvasIdleBlockers()).toEqual([]);
    expect(channel.posts.at(-1)!.kind).toBe("measure");
  });

  test("a point request never repaints the selection overlay", async () => {
    // Its reqId comes from the same counter as the selection measure, so the geometry handler
    // Dispatches on it FIRST — otherwise asking where a node is would move the selection box.
    const { channel } = await mountReadyCanvas();
    const pending = canvasPointAt(["children", 0]);
    const { reqId } = channel.posts.at(-1)!;
    channel.deliver({
      hits: [{ path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } }],
      kind: "geometry",
      reqId,
    });
    const point = await pending;
    expect(point).not.toBeNull();
    // A second, unrelated reqId is not claimed by the (now-cleared) pending measure.
    channel.deliver({ hits: [], kind: "geometry", reqId: 999 });
  });
});

describe("revealCanvasPath", () => {
  test("answers null when nothing can measure", async () => {
    const point = await revealCanvasPath(["children", 0]);
    expect(point).toBeNull();
  });

  test("pans to the measured box, waits for the pan, then re-measures", async () => {
    const { canvasEl, channel } = await mountReadyCanvas();
    const iframe = canvasEl.querySelector("iframe")!;
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 100 });
    stubRect(iframe, { height: 100, left: 0, top: 0, width: 100 });

    const pending = revealCanvasPath(["children", 0]);
    await flush(1);
    const first = channel.posts.at(-1)!;
    channel.deliver({
      hits: [{ path: ["children", 0], rect: { height: 10, width: 10, x: 0, y: 40 } }],
      kind: "geometry",
      reqId: first.reqId,
    });
    // …then the pan runs and a second measure follows once the iframe's offset stops moving.
    await flush(4);
    const second = channel.posts.at(-1)!;
    expect(second.reqId).not.toBe(first.reqId);
    expect(view.panY).not.toBe(0);
    channel.deliver({
      hits: [{ path: ["children", 0], rect: { height: 10, width: 10, x: 0, y: 10 } }],
      kind: "geometry",
      reqId: second.reqId,
    });
    const point = await pending;
    expect(point).toMatchObject({ top: 10 });
  });

  test("a path that cannot be measured is not panned to", async () => {
    const { channel } = await mountReadyCanvas();
    const pending = revealCanvasPath(["children", 9]);
    await flush(1);
    const { reqId } = channel.posts.at(-1)!;
    channel.deliver({ hits: [], kind: "geometry", reqId });
    const point = await pending;
    expect(point).toBeNull();
    // No pan and no SECOND measure: the reveal stopped at the unanswerable first measurement.
    expect(channel.posts.filter((post) => post.kind === "measure")).toHaveLength(1);
  });
});
