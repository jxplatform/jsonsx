import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { fakeChannelPair } from "../src/canvas/iframe-channel";
import { flush } from "./harness";
import { bootCanvasIframe, startCanvasIframe } from "../src/canvas/iframe-entry";
import type { IframeToParent, ParentToIframe, WireMapperCtx } from "../src/canvas/iframe-protocol";

const WIRE_CTX: WireMapperCtx = {
  arrayPaths: [],
  canvasMode: "design",
  layoutWrapped: false,
  pageContentOffset: null,
  pageContentPrefix: null,
};

function renderMsg(gen: number, doc: unknown, shadowDoc: unknown = doc): ParentToIframe {
  return {
    doc,
    docBase: "http://localhost:3000/",
    gen,
    kind: "render",
    mapperCtx: WIRE_CTX,
    mode: "design",
    shadowDoc,
    siteStyle: null,
  };
}

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
  document.body.innerHTML = "";
});

describe("startCanvasIframe", () => {
  test("announces ready, renders a posted doc, and acks renderComplete", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const fromIframe: IframeToParent[] = [];
    pair.parent.onMessage((m) => fromIframe.push(m));
    const container = document.createElement("div");

    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.flush();
    expect(fromIframe).toEqual([{ kind: "ready" }]);

    pair.parent.post(
      renderMsg(1, { children: [{ children: ["Hi"], tagName: "h1" }], tagName: "div" }),
    );
    pair.flush(); // Deliver the render command into the entry.
    await flush(); // Let the async render settle.
    pair.flush(); // Deliver the renderComplete ack back to the parent.

    expect((container.querySelector("h1") as HTMLElement)?.dataset.jxPath).toBe('["children",0]');
    expect(fromIframe).toContainEqual({ gen: 1, kind: "renderComplete" });
  });

  test("ignores a render with a stale (lower) generation", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    teardown = startCanvasIframe({ channel: pair.iframe, container });

    pair.parent.post(renderMsg(5, { children: ["new"], tagName: "section" }));
    pair.parent.post(renderMsg(2, { children: ["stale"], tagName: "article" }));
    pair.flush();
    await flush();
    pair.flush();

    expect(container.querySelector("article")).toBeNull(); // Stale gen 2 was dropped.
    expect(container.querySelector("section")?.textContent).toBe("new");
    expect(acks.filter((m) => m.kind === "renderComplete")).toEqual([
      { gen: 5, kind: "renderComplete" },
    ]);
  });

  test("reports renderError when the document cannot be rendered", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    teardown = startCanvasIframe({
      channel: pair.iframe,
      container: document.createElement("div"),
    });

    // A document whose children getter throws makes the runtime render reject.
    pair.parent.post(
      renderMsg(1, {
        get children() {
          throw new Error("boom");
        },
        tagName: "div",
      }),
    );
    pair.flush();
    await flush();
    pair.flush();

    expect(acks.some((m) => m.kind === "renderError")).toBe(true);
  });

  test("answers a measure request with the matching node's geometry", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const fromIframe: IframeToParent[] = [];
    pair.parent.onMessage((m) => fromIframe.push(m));
    const container = document.createElement("div");
    document.body.append(container); // The measure handler queries the owning document.
    teardown = startCanvasIframe({ channel: pair.iframe, container });

    pair.parent.post(
      renderMsg(1, { children: [{ children: ["Hi"], tagName: "h1" }], tagName: "div" }),
    );
    pair.flush();
    await flush();

    pair.parent.post({ kind: "measure", paths: [["children", 0]], reqId: 42 });
    pair.flush(); // Deliver the measure into the iframe entry.
    pair.flush(); // Deliver the geometry reply back to the parent.

    const geo = fromIframe.find((m) => m.kind === "geometry");
    expect(geo).toMatchObject({ kind: "geometry", reqId: 42 });
    expect((geo as { hits: { path: unknown }[] }).hits[0]!.path).toEqual(["children", 0]);
  });

  test("bootCanvasIframe wires a channel from the window and announces ready", () => {
    const posted: unknown[] = [];
    const win = {
      addEventListener: () => {},
      document: { body: document.createElement("div"), querySelector: () => null },
      location: { search: "?token=tok&parentOrigin=*" },
      parent: { postMessage: (m: unknown) => posted.push(m) },
      removeEventListener: () => {},
    };
    teardown = bootCanvasIframe(win);
    expect(posted).toEqual([{ "jx:canvas": "tok", payload: { kind: "ready" } }]);
  });

  test("bootCanvasIframe warns and falls back to '*' when parentOrigin is absent", () => {
    const warnings: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    const posted: unknown[] = [];
    const win = {
      addEventListener: () => {},
      document: { body: document.createElement("div"), querySelector: () => null },
      // No parentOrigin in the URL → the explicit "*" fallback fires + logs.
      location: { search: "?token=tok" },
      parent: { postMessage: (m: unknown) => posted.push(m) },
      removeEventListener: () => {},
    };
    try {
      teardown = bootCanvasIframe(win);
    } finally {
      console.warn = origWarn;
    }
    // Still announces ready (the channel works token-gated), and logged the loosened origin check.
    expect(posted).toEqual([{ "jx:canvas": "tok", payload: { kind: "ready" } }]);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain("no parentOrigin");
  });
});

describe("startCanvasIframe — patch", () => {
  /** A fresh doc per render: an h1 child the patches target by path `["children", 0]`. */
  const freshH1 = () => ({ children: [{ children: ["Hi"], tagName: "h1" }], tagName: "div" });

  /** Boot the iframe and land a render at `gen` so the shadow doc + DOM are ready to patch. */
  async function bootRendered(gen: number): Promise<{
    acks: IframeToParent[];
    container: HTMLElement;
    pair: ReturnType<typeof fakeChannelPair<ParentToIframe, IframeToParent>>;
  }> {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    // The render doc and the shadow doc are independent clones (as the host posts them), so folding a
    // Patch into the shadow never mutates the render tree.
    pair.parent.post(renderMsg(gen, freshH1(), freshH1()));
    pair.flush();
    await flush();
    pair.flush();
    return { acks, container, pair };
  }

  test("applies a value-carrying patch in place and acks patchComplete", async () => {
    const { acks, container, pair } = await bootRendered(1);
    pair.parent.post({
      forwardOps: [{ key: "textContent", op: "set-key", path: ["children", 0], value: "Edited" }],
      gen: 1,
      kind: "patch",
    });
    pair.flush(); // Deliver the patch into the entry (applied synchronously).
    pair.flush(); // Deliver the patchComplete ack back to the parent.

    expect((container.querySelector("h1") as HTMLElement).textContent).toBe("Edited");
    expect(acks).toContainEqual({ gen: 1, kind: "patchComplete" });
  });

  test("drops a patch whose generation is older than the rendered one", async () => {
    const { acks, container, pair } = await bootRendered(5);
    pair.parent.post({
      forwardOps: [{ key: "textContent", op: "set-key", path: ["children", 0], value: "Stale" }],
      gen: 3,
      kind: "patch",
    });
    pair.flush();
    pair.flush();

    expect((container.querySelector("h1") as HTMLElement).textContent).toBe("Hi"); // Unchanged.
    expect(acks.some((m) => m.kind === "patchComplete" || m.kind === "patchError")).toBe(false);
  });

  test("reports patchError when the patch is ahead of the rendered generation", async () => {
    const { acks, pair } = await bootRendered(1);
    pair.parent.post({
      forwardOps: [{ key: "textContent", op: "set-key", path: ["children", 0], value: "x" }],
      gen: 2,
      kind: "patch",
    });
    pair.flush();
    pair.flush();

    expect(acks).toContainEqual({ gen: 2, kind: "patchError", message: "patch-ahead-of-render" });
  });

  test("reports patchError for a patch that arrives before any render", () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    teardown = startCanvasIframe({
      channel: pair.iframe,
      container: document.createElement("div"),
    });

    pair.parent.post({
      forwardOps: [{ key: "textContent", op: "set-key", path: ["children", 0], value: "x" }],
      gen: 0,
      kind: "patch",
    });
    pair.flush();
    pair.flush();

    expect(acks).toContainEqual({ gen: 0, kind: "patchError", message: "patch-ahead-of-render" });
  });

  test("reports patchError (with the thrown reason) when an op can't be applied surgically", async () => {
    const { acks, pair } = await bootRendered(1);
    // A forward op targeting a path absent from the shadow doc — the fold throws, the iframe reports it.
    pair.parent.post({
      forwardOps: [{ key: "textContent", op: "set-key", path: ["children", 9], value: "x" }],
      gen: 1,
      kind: "patch",
    });
    pair.flush();
    pair.flush();

    const err = acks.find((m) => m.kind === "patchError") as
      | { gen: number; kind: "patchError"; message: string }
      | undefined;
    expect(err?.gen).toBe(1);
    expect(err?.message).toMatch(/doc-op-node-not-found/);
  });

  test("applies a tag-change (set-key tagName) as a surgical subtree re-render", async () => {
    const { acks, container, pair } = await bootRendered(1);
    pair.parent.post({
      forwardOps: [{ key: "tagName", op: "set-key", path: ["children", 0], value: "h2" }],
      gen: 1,
      kind: "patch",
    });
    pair.flush();
    pair.flush();

    // The h1 was re-rendered in place as an h2 (Phase 3b-2), not escalated.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Hi");
    expect(acks).toContainEqual({ gen: 1, kind: "patchComplete" });
  });
});

describe("startCanvasIframe — cross-frame drag (Phase 4c)", () => {
  const freshH1 = () => ({ children: [{ children: ["Hi"], tagName: "h1" }], tagName: "div" });

  async function bootRendered(gen: number) {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.parent.post(renderMsg(gen, freshH1(), freshH1()));
    pair.flush();
    await flush();
    pair.flush();
    return { acks, container, pair };
  }

  // Happy-dom's elementFromPoint returns null (no layout), so resolveDropTarget can't find a target
  // Here — the preview is therefore null. This test proves the MESSAGE FLOW + the seq/gen tagging,
  // Not the geometry (the non-null placement math is proven in iframe-drop.test.ts; the real
  // Point-resolution is CDP-only).
  test("dragStart→dragMove→dragOver and drop→dropResult carry the session dragSeq + gen", async () => {
    const { acks, pair } = await bootRendered(7);
    acks.length = 0;

    pair.parent.post({ dragSeq: 3, gen: 7, kind: "dragStart", src: { type: "block" } });
    pair.parent.post({ cursor: { x: 5, y: 5 }, dragSeq: 3, kind: "dragMove" });
    pair.flush();
    pair.flush();

    const over = acks.find((m) => m.kind === "dragOver");
    expect(over).toEqual({ dragSeq: 3, gen: 7, kind: "dragOver", preview: null });

    pair.parent.post({ cursor: { x: 5, y: 5 }, dragSeq: 3, kind: "drop" });
    pair.flush();
    pair.flush();

    const result = acks.find((m) => m.kind === "dropResult");
    expect(result).toEqual({
      dragSeq: 3,
      gen: 7,
      instruction: null,
      kind: "dropResult",
      targetPath: null,
    });
  });

  test("dragMove before any dragStart posts a null preview (no retained source)", async () => {
    const { acks, pair } = await bootRendered(1);
    acks.length = 0;
    pair.parent.post({ cursor: { x: 1, y: 1 }, dragSeq: 9, kind: "dragMove" });
    pair.flush();
    pair.flush();
    expect(acks.find((m) => m.kind === "dragOver")).toEqual({
      dragSeq: 9,
      gen: -1,
      kind: "dragOver",
      preview: null,
    });
  });

  test("dragEnd forgets the session: a later dragMove posts a null preview (no over-fire)", async () => {
    const { acks, pair } = await bootRendered(7);
    pair.parent.post({ dragSeq: 3, gen: 7, kind: "dragStart", src: { type: "block" } });
    pair.parent.post({ dragSeq: 3, kind: "dragEnd" });
    pair.flush();
    acks.length = 0;
    pair.parent.post({ cursor: { x: 5, y: 5 }, dragSeq: 3, kind: "dragMove" });
    pair.flush();
    pair.flush();
    // Session forgotten → dragSrc + dragGen cleared, so the preview is null and gen resets to -1.
    expect(acks.find((m) => m.kind === "dragOver")).toEqual({
      dragSeq: 3,
      gen: -1,
      kind: "dragOver",
      preview: null,
    });
  });

  test("dragCancel also forgets the session (same teardown as dragEnd)", async () => {
    const { acks, pair } = await bootRendered(7);
    pair.parent.post({ dragSeq: 4, gen: 7, kind: "dragStart", src: { type: "block" } });
    pair.parent.post({ dragSeq: 4, kind: "dragCancel" });
    pair.flush();
    acks.length = 0;
    pair.parent.post({ cursor: { x: 5, y: 5 }, dragSeq: 4, kind: "dragMove" });
    pair.flush();
    pair.flush();
    expect((acks.find((m) => m.kind === "dragOver") as { preview: unknown }).preview).toBeNull();
  });

  test("a dragMove landing in the top edge band arms auto-scroll without throwing", async () => {
    // Auto-scroll's rAF/scrollBy body is CDP-only (happy-dom has no layout/scroll); here we only
    // Prove arming the loop from a band cursor is safe and still posts the dragOver preview.
    const { acks, pair } = await bootRendered(7);
    pair.parent.post({ dragSeq: 5, gen: 7, kind: "dragStart", src: { type: "block" } });
    acks.length = 0;
    pair.parent.post({ cursor: { x: 5, y: 2 }, dragSeq: 5, kind: "dragMove" });
    pair.flush();
    pair.flush();
    expect(acks.find((m) => m.kind === "dragOver")).toBeTruthy();
    // Stop the armed loop by ending the session (teardown also cancels it).
    pair.parent.post({ dragSeq: 5, kind: "dragEnd" });
    pair.flush();
  });

  /**
   * Drive the self-sustaining auto-scroll TICK deterministically: capture the rAF callback and make
   * `scrollBy` actually advance `scrollY` so the tick proceeds PAST the extent-reached guard and
   * re-posts a dragOver, then re-arms. Covers the tick's post-scroll body without a real layout (it
   * is otherwise CDP-only).
   */
  test("the auto-scroll tick re-posts dragOver and self-sustains while held in a band", async () => {
    const win = window as unknown as {
      requestAnimationFrame: (cb: () => void) => number;
      cancelAnimationFrame: (h: number) => void;
      scrollBy: (x: number, y: number) => void;
      scrollY: number;
      innerHeight: number;
    };
    const origRaf = win.requestAnimationFrame;
    const origCancel = win.cancelAnimationFrame;
    const origScrollBy = win.scrollBy;
    const rafCbs: (() => void)[] = [];
    win.requestAnimationFrame = (cb: () => void) => {
      rafCbs.push(cb);
      return rafCbs.length;
    };
    win.cancelAnimationFrame = () => {};
    let scrollY = 0;
    Object.defineProperty(win, "scrollY", { configurable: true, get: () => scrollY });
    win.scrollBy = (_x: number, y: number) => {
      scrollY += y;
    };
    Object.defineProperty(win, "innerHeight", { configurable: true, value: 800 });

    try {
      const { acks, pair } = await bootRendered(7);
      pair.parent.post({ dragSeq: 8, gen: 7, kind: "dragStart", src: { type: "block" } });
      // A bottom-band cursor (y near innerHeight) arms the loop and queues the first rAF.
      pair.parent.post({ cursor: { x: 5, y: 790 }, dragSeq: 8, kind: "dragMove" });
      pair.flush();
      acks.length = 0;
      // Fire the queued tick: scrollBy advances scrollY (≠ before), so it re-posts + re-arms.
      expect(rafCbs).toHaveLength(1);
      rafCbs.shift()!();
      pair.flush();
      expect(acks.find((m) => m.kind === "dragOver")).toBeTruthy();
      // The loop re-armed (still in the band); fire once more to exercise the self-sustain edge.
      expect(rafCbs).toHaveLength(1);
      rafCbs.shift()!();
      pair.flush();
      pair.parent.post({ dragSeq: 8, kind: "dragEnd" });
      pair.flush();
    } finally {
      win.requestAnimationFrame = origRaf;
      win.cancelAnimationFrame = origCancel;
      win.scrollBy = origScrollBy;
    }
  });

  // Flow 3 is fully iframe-driven: the detector (wired with the entry's previewAt/gen/auto-scroll
  // Deps) computes + posts dragOver/dropResult LOCALLY from its own pointer. Happy-dom has no
  // ElementFromPoint, so previewAt resolves null — this proves the message FLOW + the deps wiring
  // (cursor carried, gen threaded, auto-scroll armed), not the (CDP-only) geometry.
  test("a body-grab pointer gesture drives dragOriginate → dragOver(cursor) → dropResult locally", async () => {
    const { acks, container, pair } = await bootRendered(7);
    const h1 = container.querySelector("h1")!;
    acks.length = 0;

    h1.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 200 }),
    );
    // A move past threshold (and into the bottom edge band, y large) originates + drives + arms.
    container.ownerDocument.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 200 }),
    );
    pair.flush();

    const originate = acks.find((m) => m.kind === "dragOriginate") as
      | { dragSeq: number; path: unknown }
      | undefined;
    expect(originate).toMatchObject({ kind: "dragOriginate", path: ["children", 0] });
    const over = acks.find((m) => m.kind === "dragOver") as
      | { cursor?: { x: number; y: number }; gen: number }
      | undefined;
    // The dragOver carries the iframe-local cursor (for the parent ghost) + the rendered gen.
    expect(over?.cursor).toEqual({ x: 40, y: 200 });
    expect(over?.gen).toBe(7);

    container.ownerDocument.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 210 }),
    );
    pair.flush();
    const result = acks.find((m) => m.kind === "dropResult");
    // Null target (no layout) → null instruction, but the result is posted with the session seq+gen.
    expect(result).toMatchObject({
      dragSeq: originate!.dragSeq,
      gen: 7,
      instruction: null,
      kind: "dropResult",
      targetPath: null,
    });
  });
});

describe("startCanvasIframe — content-height auto-sizing + wheel forwarding", () => {
  const freshH1 = () => ({ children: [{ children: ["Hi"], tagName: "h1" }], tagName: "div" });

  // Append the container so its ownerDocument is the live document the wheel listener binds to and the
  // Stubbed scrollHeight is read from.
  async function bootRendered(gen: number) {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.parent.post(renderMsg(gen, freshH1(), freshH1()));
    pair.flush();
    await flush();
    pair.flush();
    return { acks, container, pair };
  }

  test("posts the measured content height after a successful render", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    // Stub the layout-free happy-dom scrollHeight so the post-render measure has a concrete value.
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1234 });

    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.parent.post(renderMsg(1, freshH1(), freshH1()));
    pair.flush(); // Deliver the render command.
    await flush(); // Let the async render settle (postContentHeight runs right after renderComplete).
    pair.flush(); // Deliver the acks back to the parent.

    expect(acks).toContainEqual({ height: 1234, kind: "contentHeight" });
  });

  test("forwards a wheel event (deltas) to the parent and prevents the default", async () => {
    const { acks, container, pair } = await bootRendered(1);
    acks.length = 0;

    const evt = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 200,
      ctrlKey: true,
      deltaX: 3,
      deltaY: 7,
      metaKey: false,
      shiftKey: true,
    });
    container.ownerDocument.dispatchEvent(evt);
    pair.flush(); // Deliver the forwardWheel post back to the parent.

    // Happy-dom's WheelEvent extends UIEvent (not MouseEvent), so clientX/Y + modifiers are undefined;
    // The deterministically-assertable forwarded fields are the deltas. preventDefault is honored.
    const wheel = acks.find((m) => m.kind === "forwardWheel");
    expect(wheel).toMatchObject({ deltaX: 3, deltaY: 7, kind: "forwardWheel" });
    expect(evt.defaultPrevented).toBe(true);
  });

  test("teardown removes the wheel listener: a later wheel dispatch posts nothing", async () => {
    const { acks, container, pair } = await bootRendered(1);
    teardown!();
    teardown = undefined;
    acks.length = 0;

    container.ownerDocument.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 9, deltaY: 9 }),
    );
    pair.flush();

    expect(acks.some((m) => m.kind === "forwardWheel")).toBe(false);
  });
});
