/**
 * Iframe entry gaps — a resolvable drop target (stubbed elementFromPoint) through previewAt, the
 * auto-scroll tick's stop conditions (session gone / out of band / scroll extent reached), and the
 * native dragover/drop session guards (dataTransfer dropEffect, unclaimed drop).
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { fakeChannelPair } from "../src/canvas/iframe-channel";
import { flush } from "./harness";
import { startCanvasIframe } from "../src/canvas/iframe-entry";
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
    colorScheme: null,
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

const freshDoc = () => ({
  children: [
    { children: ["One"], tagName: "p" },
    { children: ["Two"], tagName: "p" },
  ],
  tagName: "div",
});

let teardown: (() => void) | undefined;

async function bootRendered(gen: number) {
  const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
  const acks: IframeToParent[] = [];
  pair.parent.onMessage((m) => acks.push(m));
  const container = document.createElement("div");
  document.body.append(container);
  teardown = startCanvasIframe({ channel: pair.iframe, container });
  pair.parent.post(renderMsg(gen, freshDoc(), freshDoc()));
  pair.flush();
  await flush();
  pair.flush();
  return { acks, container, pair };
}

afterEach(() => {
  teardown?.();
  teardown = undefined;
  document.body.innerHTML = "";
});

describe("previewAt with a resolvable target", () => {
  test("a dragMove over a stamped element posts a concrete placement preview", async () => {
    const { acks, container, pair } = await bootRendered(3);
    const first = container.querySelector("p") as HTMLElement;
    // Happy-dom has no layout: resolve the hit-test and rects directly.
    document.elementFromPoint = () => first;
    first.getBoundingClientRect = () =>
      ({
        bottom: 40,
        height: 20,
        left: 0,
        right: 100,
        top: 20,
        width: 100,
        x: 0,
        y: 20,
      }) as DOMRect;
    try {
      pair.parent.post({ dragSeq: 2, gen: 3, kind: "dragStart", src: { type: "block" } });
      acks.length = 0;
      pair.parent.post({ cursor: { x: 10, y: 22 }, dragSeq: 2, kind: "dragMove" });
      pair.flush();
      pair.flush();

      const over = acks.find((m) => m.kind === "dragOver") as
        | { preview: { targetPath: unknown; instruction: string } | null }
        | undefined;
      expect(over?.preview).not.toBeNull();
      expect(over?.preview?.targetPath).toEqual(["children", 0]);
      expect(typeof over?.preview?.instruction).toBe("string");
      pair.parent.post({ dragSeq: 2, kind: "dragEnd" });
      pair.flush();
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });
});

describe("auto-scroll tick stop conditions", () => {
  interface ScrollWindow {
    requestAnimationFrame: (cb: () => void) => number;
    cancelAnimationFrame: (h: number) => void;
    scrollBy: (x: number, y: number) => void;
    scrollY: number;
    innerHeight: number;
  }

  function hijackScroll() {
    const win = window as unknown as ScrollWindow;
    const orig = {
      cancel: win.cancelAnimationFrame,
      raf: win.requestAnimationFrame,
      scrollBy: win.scrollBy,
    };
    const rafCbs: (() => void)[] = [];
    win.requestAnimationFrame = (cb: () => void) => {
      rafCbs.push(cb);
      return rafCbs.length;
    };
    win.cancelAnimationFrame = () => {};
    Object.defineProperty(win, "innerHeight", { configurable: true, value: 800 });
    return {
      rafCbs,
      restore: () => {
        win.requestAnimationFrame = orig.raf;
        win.cancelAnimationFrame = orig.cancel;
        win.scrollBy = orig.scrollBy;
      },
      win,
    };
  }

  test("a tick after the session ended is inert", async () => {
    const { rafCbs, restore } = hijackScroll();
    try {
      const { acks, pair } = await bootRendered(7);
      pair.parent.post({ dragSeq: 4, gen: 7, kind: "dragStart", src: { type: "block" } });
      pair.parent.post({ cursor: { x: 5, y: 790 }, dragSeq: 4, kind: "dragMove" });
      pair.flush();
      pair.flush(); // Drain the dragMove's own dragOver before observing the tick.
      expect(rafCbs).toHaveLength(1);
      // The session ends (clears the cached cursor) BEFORE the queued tick fires.
      pair.parent.post({ dragSeq: 4, kind: "dragEnd" });
      pair.flush();
      acks.length = 0;
      rafCbs.shift()!();
      pair.flush();
      expect(acks).toHaveLength(0);
      expect(rafCbs).toHaveLength(0); // The loop did not re-arm.
    } finally {
      restore();
    }
  });

  test("a tick whose cursor left the edge band stops the loop", async () => {
    const { rafCbs, restore, win } = hijackScroll();
    try {
      const { acks, pair } = await bootRendered(7);
      pair.parent.post({ dragSeq: 5, gen: 7, kind: "dragStart", src: { type: "block" } });
      pair.parent.post({ cursor: { x: 5, y: 790 }, dragSeq: 5, kind: "dragMove" });
      pair.flush();
      pair.flush(); // Drain the dragMove's own dragOver before observing the tick.
      expect(rafCbs).toHaveLength(1);
      // Grow the viewport so the same y is no longer in the bottom band.
      Object.defineProperty(win, "innerHeight", { configurable: true, value: 4000 });
      acks.length = 0;
      rafCbs.shift()!();
      pair.flush();
      expect(acks).toHaveLength(0);
      expect(rafCbs).toHaveLength(0);
      pair.parent.post({ dragSeq: 5, kind: "dragEnd" });
      pair.flush();
    } finally {
      restore();
    }
  });

  test("a tick at the scroll extent stops without re-posting", async () => {
    const { rafCbs, restore, win } = hijackScroll();
    // ScrollBy is a no-op: scrollY never advances → extent reached.
    Object.defineProperty(win, "scrollY", { configurable: true, get: () => 0 });
    win.scrollBy = () => {};
    try {
      const { acks, pair } = await bootRendered(7);
      pair.parent.post({ dragSeq: 6, gen: 7, kind: "dragStart", src: { type: "block" } });
      pair.parent.post({ cursor: { x: 5, y: 790 }, dragSeq: 6, kind: "dragMove" });
      pair.flush();
      pair.flush(); // Drain the dragMove's own dragOver before observing the tick.
      expect(rafCbs).toHaveLength(1);
      acks.length = 0;
      rafCbs.shift()!();
      pair.flush();
      expect(acks).toHaveLength(0);
      expect(rafCbs).toHaveLength(0);
      pair.parent.post({ dragSeq: 6, kind: "dragEnd" });
      pair.flush();
    } finally {
      restore();
    }
  });
});

describe("entry-wired accessor seams", () => {
  test("a design-mode pointermove threads the shadow doc into the insert-zone computation", async () => {
    const { acks, container, pair } = await bootRendered(1);
    acks.length = 0;
    const p = container.querySelector("p") as HTMLElement;
    p.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }));
    pair.flush();
    // The interaction layer read the mode + shadow doc through the entry's accessors and posted
    // The hover (and, with a resolvable geometry, the zone set) for the stamped node.
    expect(acks.some((m) => m.kind === "hover" || m.kind === "insertZones")).toBe(true);
  });

  test("a prop-bound click consults the entry's shadow doc and starts a prop session", async () => {
    const { acks, container, pair } = await bootRendered(1);
    // A component instance stamped at a real doc path, with a runtime prop-bound marker inside.
    const host = document.createElement("x-card");
    host.dataset.jxPath = '["children",0]';
    const marker = document.createElement("span");
    marker.dataset.jxBoundProp = "title";
    marker.textContent = "Card title";
    host.append(marker);
    container.append(host);
    acks.length = 0;

    // A single pointerdown opens the nested editing host — prop-bound internals sit inside a
    // `contenteditable="false"` island, so the press is what makes them reachable at all.
    marker.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    pair.flush();
    const { isEditing, stopEditing } = await import("../src/editor/inline-edit");
    // The raw $props value is unset in the shadow doc → editing ADDS the prop (permitted).
    expect(isEditing()).toBe(true);
    expect(acks.find((m) => m.kind === "editStart")).toMatchObject({
      path: ["children", 0],
      prop: "title",
    });
    stopEditing();
  });
});

describe("native drag session guards", () => {
  test("a claimed native dragover sets the move dropEffect on its dataTransfer", async () => {
    const { acks, pair } = await bootRendered(7);
    pair.parent.post({ dragSeq: 8, gen: 7, kind: "dragStart", src: { type: "block" } });
    pair.flush();
    acks.length = 0;
    const ev = new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
    });
    const dt = { dropEffect: "none" };
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    document.dispatchEvent(ev);
    pair.flush();
    expect(ev.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe("move");
    expect(acks.some((m) => m.kind === "dragOver")).toBe(true);
  });

  test("a native drop with no live session is ignored", async () => {
    const { acks, pair } = await bootRendered(7);
    acks.length = 0;
    const drop = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
    });
    document.dispatchEvent(drop);
    pair.flush();
    expect(drop.defaultPrevented).toBe(false);
    expect(acks.some((m) => m.kind === "dropResult")).toBe(false);
  });
});

// ─── External file drops (flow 5) ─────────────────────────────────────────────

/** Dispatch a native drag event carrying OS files, with a stub dataTransfer. */
function fileDrag(
  type: string,
  files: File[],
  opts: { clientX?: number; clientY?: number; relatedTarget?: EventTarget | null } = {},
) {
  const { relatedTarget = null, ...mouse } = opts;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...mouse });
  const dataTransfer = { dropEffect: "none", files, types: ["Files"] };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  document.dispatchEvent(event);
  return { dataTransfer, event };
}

describe("external file drag", () => {
  test("isExternalFileDrag reads the dataTransfer types list", async () => {
    const { isExternalFileDrag } = await import("../src/canvas/iframe-entry");
    const withFiles = { dataTransfer: { types: ["Files"] } } as unknown as DragEvent;
    const withText = { dataTransfer: { types: ["text/plain"] } } as unknown as DragEvent;
    expect(isExternalFileDrag(withFiles)).toBe(true);
    expect(isExternalFileDrag(withText)).toBe(false);
    expect(isExternalFileDrag({} as DragEvent)).toBe(false);
  });

  test("a file dragover is accepted with the copy effect and posts geometry", async () => {
    const { acks, container, pair } = await bootRendered(11);
    const first = container.querySelector("p") as HTMLElement;
    document.elementFromPoint = () => first;
    try {
      acks.length = 0;
      const { dataTransfer, event } = fileDrag("dragover", [new File(["x"], "a.png")], {
        clientX: 5,
        clientY: 5,
      });
      pair.flush();

      // Without preventDefault the browser shows "not allowed" and swallows the drop.
      expect(event.defaultPrevented).toBe(true);
      expect(dataTransfer.dropEffect).toBe("copy");
      const over = acks.find((m) => m.kind === "fileDragOver") as
        | { hit: { path: unknown; tagName: string } | null }
        | undefined;
      expect(over).toBeDefined();
      expect(over?.hit?.path).toEqual(["children", 0]);
      // The tag comes from the SHADOW DOC — that is the node the parent will mutate.
      expect(over?.hit?.tagName).toBe("p");
      // A file drag never claims the parent's pragmatic session.
      expect(acks.some((m) => m.kind === "nativeDragEnter")).toBe(false);
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  test("a file drop posts the File objects across the boundary", async () => {
    const { acks, container, pair } = await bootRendered(12);
    const first = container.querySelector("p") as HTMLElement;
    document.elementFromPoint = () => first;
    const file = new File(["x"], "a.png");
    try {
      acks.length = 0;
      const { event } = fileDrag("drop", [file], { clientX: 5, clientY: 5 });
      pair.flush();

      expect(event.defaultPrevented).toBe(true);
      const drop = acks.find((m) => m.kind === "fileDrop") as { files: File[] } | undefined;
      // FileList is not structured-cloneable; the iframe spreads it to a plain array.
      expect(drop?.files).toEqual([file]);
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  test("a file drag over nothing addressable still posts, with a null hit", async () => {
    const { acks, pair } = await bootRendered(13);
    document.elementFromPoint = () => null;
    try {
      acks.length = 0;
      fileDrag("dragover", [new File(["x"], "a.png")], { clientX: 5, clientY: 5 });
      pair.flush();
      const over = acks.find((m) => m.kind === "fileDragOver") as
        | { hit: unknown; preview: unknown }
        | undefined;
      expect(over?.hit).toBeNull();
      expect(over?.preview).toBeNull();
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  test("leaving the frame posts fileDragLeave; an inner boundary crossing does not", async () => {
    const { acks, container, pair } = await bootRendered(14);
    acks.length = 0;

    // RelatedTarget set = the cursor moved onto another element INSIDE the frame.
    fileDrag("dragleave", [new File(["x"], "a.png")], { relatedTarget: container });
    pair.flush();
    expect(acks.some((m) => m.kind === "fileDragLeave")).toBe(false);

    fileDrag("dragleave", [new File(["x"], "a.png")], { relatedTarget: null });
    pair.flush();
    expect(acks.some((m) => m.kind === "fileDragLeave")).toBe(true);
  });

  test("a live parent session still wins — a file drag never hijacks it", async () => {
    const { acks, pair } = await bootRendered(15);
    pair.parent.post({ dragSeq: 3, gen: 15, kind: "dragStart", src: { type: "block" } });
    pair.flush();
    acks.length = 0;

    const { dataTransfer } = fileDrag("dragover", [new File(["x"], "a.png")], {
      clientX: 5,
      clientY: 5,
    });
    pair.flush();

    expect(dataTransfer.dropEffect).toBe("move");
    expect(acks.some((m) => m.kind === "fileDragOver")).toBe(false);
    expect(acks.some((m) => m.kind === "dragOver")).toBe(true);
  });
});
