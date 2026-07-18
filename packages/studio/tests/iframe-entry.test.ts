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

  test("setColorScheme flips the root attribute without a render", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const fromIframe: IframeToParent[] = [];
    pair.parent.onMessage((m) => fromIframe.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.flush();

    pair.parent.post({ kind: "setColorScheme", scheme: "dark" });
    pair.flush();
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    // No render was triggered — only the ready announcement crossed back.
    expect(fromIframe.map((m) => m.kind)).toEqual(["ready"]);

    pair.parent.post({ kind: "setColorScheme", scheme: null });
    pair.flush();
    expect(document.documentElement.dataset.colorScheme).toBeUndefined();
  });

  test("siteStyleUpdate replaces the site-style sheet in place without a render", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const fromIframe: IframeToParent[] = [];
    pair.parent.onMessage((m) => fromIframe.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.flush();

    pair.parent.post({
      kind: "siteStyleUpdate",
      media: { "--dark": "(prefers-color-scheme: dark)" },
      siteStyle: { "--brand": "#0f0", "@--dark": { "--brand": "#111" } },
    });
    pair.flush();
    const css = document.head.querySelector("#jx-site-style")!.textContent!;
    expect(css).toContain(":root { --brand: #0f0 }");
    expect(css).toContain(':root:where([data-color-scheme="dark"]) { --brand: #111 }');
    // No render happened — only the ready announcement crossed back.
    expect(fromIframe.map((m) => m.kind)).toEqual(["ready"]);

    pair.parent.post({ kind: "siteStyleUpdate", media: {}, siteStyle: null });
    pair.flush();
    expect(document.head.querySelector("#jx-site-style")).toBeNull();
  });

  test("a render message applies its colorScheme to the root", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const container = document.createElement("div");
    document.body.append(container);
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.flush();

    const msg = renderMsg(1, { children: [{ children: ["Hi"], tagName: "h1" }], tagName: "div" });
    (msg as { colorScheme: "light" | "dark" | null }).colorScheme = "light";
    pair.parent.post(msg);
    pair.flush();
    await flush();
    expect(document.documentElement.dataset.colorScheme).toBe("light");
    delete document.documentElement.dataset.colorScheme;
  });

  test("posts a serialized dataScope right AFTER renderComplete (resolved $defs cross to the parent)", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const fromIframe: IframeToParent[] = [];
    pair.parent.onMessage((m) => fromIframe.push(m));
    const container = document.createElement("div");

    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.flush();

    // A doc with `state` → buildScope resolves it, and the entry threads the snapshot to the parent.
    const doc = {
      children: [{ children: ["Hi"], tagName: "h1" }],
      state: { title: "Home" },
      tagName: "div",
    };
    pair.parent.post(renderMsg(1, doc));
    pair.flush();
    await flush();
    pair.flush();

    const kinds = fromIframe.map((m) => m.kind);
    const doneIdx = kinds.indexOf("renderComplete");
    const scopeIdx = kinds.indexOf("dataScope");
    // Ordering: dataScope follows renderComplete (fills S.canvas.scope right after the render ack).
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(scopeIdx).toBeGreaterThan(doneIdx);
    const scopeMsg = fromIframe[scopeIdx] as { gen: number; scope: Record<string, unknown> };
    expect(scopeMsg.gen).toBe(1);
    // The resolved state value crossed as plain, structured-clone-safe data.
    expect(scopeMsg.scope.title).toBe("Home");
  });

  test("re-posts dataScope when an async data source settles AFTER the render", async () => {
    // A bare-specifier $src resolves via the dev proxy: the runtime returns ref(null) immediately
    // And fills it when the /__jx_resolve__ fetch lands — i.e. AFTER renderComplete. The entry's
    // Reactive effect must then re-post an updated snapshot (else the explorer shows null forever).
    const realFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/__jx_resolve__")) {
        return gate.then(() => Response.json([{ title: "Kubota U35" }]));
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
      const fromIframe: IframeToParent[] = [];
      pair.parent.onMessage((m) => fromIframe.push(m));
      const container = document.createElement("div");
      teardown = startCanvasIframe({ channel: pair.iframe, container });
      pair.flush();

      const doc = {
        children: [{ children: ["Hi"], tagName: "h1" }],
        state: { products: { $prototype: "Catalog", $src: "some-pkg/Catalog.class.json" } },
        tagName: "div",
      };
      pair.parent.post(renderMsg(1, doc));
      pair.flush();
      await flush();
      pair.flush();

      const scopes = () =>
        fromIframe.filter((m) => m.kind === "dataScope") as {
          gen: number;
          scope: Record<string, unknown>;
        }[];
      // First snapshot: the dev-proxy fetch hasn't landed, so the ref serializes to null.
      expect(scopes()).toHaveLength(1);
      expect(scopes()[0]!.scope.products).toBeNull();

      // The resolve lands → the ref fills → the tracked effect re-posts an updated snapshot.
      release();
      await flush();
      pair.flush();
      expect(scopes()).toHaveLength(2);
      expect(scopes()[1]!.gen).toBe(1);
      expect(scopes()[1]!.scope.products).toEqual([{ title: "Kubota U35" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
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

  // ─── Native drag routing: Chromium delivers dragover/drop to the frame under the cursor, so a
  // Parent-originated drag over the canvas arrives here as NATIVE events, not dragMove messages.
  test("a NATIVE dragover with a live session preventDefaults and posts a cursor-carrying dragOver", async () => {
    const { acks, pair } = await bootRendered(7);
    pair.parent.post({ dragSeq: 6, gen: 7, kind: "dragStart", src: { type: "block" } });
    pair.flush();
    acks.length = 0;
    const ev = new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
    });
    document.dispatchEvent(ev);
    pair.flush();
    // Accepted (no "not allowed" cursor) + the preview posted from OUR viewport coords, cursor
    // Included so the parent can keep its ghost tracking (it sees no dragover of its own).
    expect(ev.defaultPrevented).toBe(true);
    expect(acks.find((m) => m.kind === "dragOver")).toEqual({
      cursor: { x: 5, y: 5 },
      dragSeq: 6,
      gen: 7,
      kind: "dragOver",
      preview: null,
    });
  });

  test("a NATIVE drop posts the authoritative dropResult and ends the session", async () => {
    const { acks, pair } = await bootRendered(7);
    pair.parent.post({ dragSeq: 6, gen: 7, kind: "dragStart", src: { type: "block" } });
    pair.flush();
    acks.length = 0;
    const drop = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
    });
    document.dispatchEvent(drop);
    pair.flush();
    expect(drop.defaultPrevented).toBe(true);
    expect(acks.find((m) => m.kind === "dropResult")).toEqual({
      dragSeq: 6,
      gen: 7,
      instruction: null,
      kind: "dropResult",
      targetPath: null,
    });
    // The session ended with the drop: a later native dragover is unclaimed (not accepted).
    acks.length = 0;
    const after = new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
    });
    document.dispatchEvent(after);
    pair.flush();
    expect(after.defaultPrevented).toBe(false);
    expect(acks.find((m) => m.kind === "dragOver")).toBeUndefined();
  });

  test("a NATIVE dragover with NO session posts nativeDragEnter once per throttle window", async () => {
    const { acks, pair } = await bootRendered(7);
    acks.length = 0;
    const fire = () => {
      const ev = new MouseEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientX: 5,
        clientY: 5,
      });
      document.dispatchEvent(ev);
      return ev;
    };
    const first = fire();
    fire();
    pair.flush();
    // Unclaimed stream: never accepted (an OS file drag must keep the browser's default), and the
    // Crossing announced exactly once within the throttle window (dragover re-fires ~350ms).
    expect(first.defaultPrevented).toBe(false);
    expect(acks.filter((m) => m.kind === "nativeDragEnter")).toHaveLength(1);
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

// ─── Live expression eval (M6): evalExpr → evalResult against the LIVE scope ────

describe("startCanvasIframe — live expression eval (M6)", () => {
  async function bootWithState(gen: number, doc: unknown) {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.parent.post(renderMsg(gen, doc));
    pair.flush();
    await flush();
    pair.flush();
    return { acks, pair };
  }

  const evalResults = (acks: IframeToParent[]) =>
    acks.filter((m) => m.kind === "evalResult") as {
      gen: number;
      reqId: number;
      results: { id: string; values: [string, string][]; error?: string }[];
    }[];

  test("evaluates against the live resolved scope and replies with formatted per-node values", async () => {
    const doc = {
      children: [{ children: ["Hi"], tagName: "h1" }],
      state: { count: 40 },
      tagName: "div",
    };
    const { acks, pair } = await bootWithState(1, doc);
    acks.length = 0;

    pair.parent.post({
      contextPath: null,
      exprs: [{ id: "sum", node: { operator: "+", target: { $ref: "#/state/count" }, value: 2 } }],
      gen: 1,
      kind: "evalExpr",
      reqId: 7,
    });
    pair.flush(); // Deliver the request into the entry.
    pair.flush(); // Deliver the reply back to the parent.

    const [reply] = evalResults(acks);
    expect(reply).toMatchObject({ gen: 1, kind: "evalResult", reqId: 7 });
    expect(reply!.results).toHaveLength(1);
    const values = new Map(reply!.results[0]!.values);
    expect(values.get("")).toBe("42");
    expect(values.get("target")).toBe("40");
  });

  test("a stale-gen request gets an EMPTY reply (never values from the wrong scope)", async () => {
    const { acks, pair } = await bootWithState(5, {
      children: [],
      state: { count: 1 },
      tagName: "div",
    });
    acks.length = 0;

    pair.parent.post({
      contextPath: null,
      exprs: [{ id: "x", node: { operator: "+", target: 1, value: 1 } }],
      gen: 3, // The render this targeted was superseded.
      kind: "evalExpr",
      reqId: 9,
    });
    pair.flush();
    pair.flush();

    const [reply] = evalResults(acks);
    expect(reply).toMatchObject({ gen: 3, reqId: 9, results: [] });
  });

  test("guards errors per expression and never mutates the live canvas state", async () => {
    const doc = {
      children: [{ children: ["Hi"], tagName: "h1" }],
      state: { cart: [1, 2] },
      tagName: "div",
    };
    const { acks, pair } = await bootWithState(1, doc);
    acks.length = 0;

    const push = { operator: "push", target: { $ref: "#/state/cart" }, value: 3 };
    pair.parent.post({
      contextPath: null,
      exprs: [
        { id: "bad", node: { operator: "bogus", target: 1 } },
        { id: "mutate", node: push },
      ],
      gen: 1,
      kind: "evalExpr",
      reqId: 1,
    });
    pair.flush();
    pair.flush();
    // Evaluate the mutating expression AGAIN: were the live scope touched, cart would have grown
    // And push would now report 4.
    pair.parent.post({
      contextPath: null,
      exprs: [{ id: "mutate", node: push }],
      gen: 1,
      kind: "evalExpr",
      reqId: 2,
    });
    pair.flush();
    pair.flush();

    const replies = evalResults(acks);
    expect(replies[0]!.results[0]!.error).toContain("unknown operator");
    expect(new Map(replies[0]!.results[1]!.values).get("")).toBe("3");
    expect(new Map(replies[1]!.results[0]!.values).get("")).toBe("3"); // Same pre-mutation state.
  });

  test("binds the first rendered item's $map context for a repeater-template contextPath", async () => {
    const doc = {
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/products" },
          map: { children: [{ tagName: "h3" }], tagName: "li" },
        },
      ],
      state: { products: [{ title: "Kubota U35" }, { title: "Other" }] },
      tagName: "ul",
    };
    const { acks, pair } = await bootWithState(1, doc);
    acks.length = 0;

    pair.parent.post({
      contextPath: ["children", 0, "map", "children", 0],
      exprs: [
        { id: "t", node: { operator: "??", target: { $ref: "$map/item/title" }, value: "?" } },
      ],
      gen: 1,
      kind: "evalExpr",
      reqId: 3,
    });
    pair.flush();
    pair.flush();

    const [reply] = evalResults(acks);
    expect(reply!.results[0]!.error).toBeUndefined();
    expect(new Map(reply!.results[0]!.values).get("")).toBe('"Kubota U35"');
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

    // A plain page root → fragment:false (the host keeps its 480px floor).
    expect(acks).toContainEqual({ fragment: false, height: 1234, kind: "contentHeight" });
  });

  test("flags fragment:true when the rendered root is a component definition (data-jx-definition-root)", async () => {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 400 });

    teardown = startCanvasIframe({ channel: pair.iframe, container });
    // A doc whose root tag is a custom element → makeStamper marks it data-jx-definition-root.
    const compDoc = { children: [{ children: ["Hi"], tagName: "h2" }], tagName: "x-cta-frag" };
    pair.parent.post(renderMsg(1, compDoc, compDoc));
    pair.flush();
    await flush();
    pair.flush();

    expect((container.firstElementChild as HTMLElement).dataset.jxDefinitionRoot).toBe("");
    expect(acks).toContainEqual({ fragment: true, height: 400, kind: "contentHeight" });
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

// ─── Render/patch vs live edit session (tab-identity lifecycle guards) ─────────

describe("render/patch vs live edit session", () => {
  const P_DOC = () => ({
    children: [{ children: ["Hi"], tagName: "p" }],
    tagName: "div",
  });

  async function bootEditable() {
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.parent.post(renderMsg(1, P_DOC(), P_DOC()));
    pair.flush();
    await flush();
    pair.flush();
    const { startEditing } = await import("../src/editor/inline-edit");
    const el = container.querySelector("p") as HTMLElement;
    const calls: string[] = [];
    startEditing(el, ["children", 0], {
      onCommit: (path, children, textContent) => {
        calls.push("commit");
        pair.iframe.post({ children, kind: "editCommit", path, textContent });
      },
      onEnd: () => {
        calls.push("end");
        pair.iframe.post({ kind: "editEnd" });
      },
      onInsert: () => {},
      onSplit: () => {},
    });
    return { acks, calls, container, el, pair };
  }

  test("a render arriving mid-session COMMITS it, and the commit precedes renderComplete", async () => {
    const { acks, container, el, pair } = await bootEditable();
    el.textContent = "typed";
    acks.length = 0;

    pair.parent.post(renderMsg(2, P_DOC(), P_DOC()));
    pair.flush();
    await flush();
    pair.flush();

    const { isEditing } = await import("../src/editor/inline-edit");
    expect(isEditing()).toBe(false);
    const kinds = acks.map((m) => m.kind);
    const commitIdx = kinds.indexOf("editCommit");
    const doneIdx = kinds.indexOf("renderComplete");
    // FIFO: the commit posts BEFORE the ack that flips the host's tab identity.
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(commitIdx);
    expect(acks[commitIdx]).toMatchObject({ path: ["children", 0], textContent: "typed" });
    expect(container.querySelector("p")).toBeTruthy();
  });

  test("a STALE-gen render does not end the session", async () => {
    const { acks, pair } = await bootEditable();
    acks.length = 0;

    pair.parent.post(renderMsg(0, P_DOC(), P_DOC()));
    pair.flush();
    await flush();
    pair.flush();

    const { isEditing, stopEditing } = await import("../src/editor/inline-edit");
    expect(isEditing()).toBe(true);
    expect(acks.some((m) => m.kind === "editCommit")).toBe(false);
    stopEditing();
  });

  test("a patch that re-renders the edited subtree ends the session first; text/style elsewhere do not", async () => {
    const { acks, pair } = await bootEditable();
    acks.length = 0;

    // In-place text patch on ANOTHER node — the session survives.
    pair.parent.post({
      forwardOps: [{ key: "textContent", op: "set-key", path: ["children", 1], value: "x" }],
      gen: 1,
      kind: "patch",
    });
    pair.flush();
    const { isEditing } = await import("../src/editor/inline-edit");
    expect(isEditing()).toBe(true);

    // A children re-render on the edited node itself — commit-and-end BEFORE the patch applies.
    pair.parent.post({
      forwardOps: [{ key: "children", op: "set-key", path: ["children", 0], value: ["swapped"] }],
      gen: 1,
      kind: "patch",
    });
    pair.flush();
    expect(isEditing()).toBe(false);
    pair.flush(); // Deliver the commit the guard posted during the patch handling.
    expect(acks.some((m) => m.kind === "editCommit")).toBe(true);
  });
});

describe("patchDisturbsActiveEdit", () => {
  test("classifies ops against the live edit path", async () => {
    const { patchDisturbsActiveEdit } = await import("../src/canvas/iframe-entry");
    const { startEditing, stopEditing } = await import("../src/editor/inline-edit");

    // No session → nothing disturbs.
    expect(
      patchDisturbsActiveEdit([{ key: "children", op: "set-key", path: ["children", 0] }]),
    ).toBe(false);

    const el = document.createElement("p");
    document.body.append(el);
    startEditing(el, ["children", 0, "children", 1], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    try {
      // In-place set-keys (style/text/event) never disturb, wherever they land.
      expect(
        patchDisturbsActiveEdit([
          { key: "style", op: "set-key", path: ["children", 0, "children", 1] },
          { key: "textContent", op: "set-key", path: ["children", 0, "children", 1] },
          { key: "onclick", op: "set-key", path: ["children", 0, "children", 1] },
        ]),
      ).toBe(false);
      // A subtree-re-rendering set-key on an ancestor-or-self disturbs…
      expect(
        patchDisturbsActiveEdit([{ key: "children", op: "set-key", path: ["children", 0] }]),
      ).toBe(true);
      // …but on an unrelated branch does not.
      expect(
        patchDisturbsActiveEdit([{ key: "children", op: "set-key", path: ["children", 2] }]),
      ).toBe(false);
      // Structural ops compare their PARENT path (sibling churn can reflow the edited element).
      expect(
        patchDisturbsActiveEdit([
          { index: 0, node: {}, op: "insert-child", parentPath: ["children", 0] },
        ]),
      ).toBe(true);
      expect(
        patchDisturbsActiveEdit([{ index: 0, op: "remove-child", parentPath: ["children", 2] }]),
      ).toBe(false);
      // Move: either endpoint's parent counts.
      expect(
        patchDisturbsActiveEdit([
          {
            fromIndex: 0,
            fromParentPath: ["children", 2],
            op: "move-child",
            toIndex: 0,
            toParentPath: ["children", 0],
          },
        ]),
      ).toBe(true);
      expect(
        patchDisturbsActiveEdit([
          {
            fromIndex: 0,
            fromParentPath: ["children", 2],
            op: "move-child",
            toIndex: 1,
            toParentPath: ["children", 3],
          },
        ]),
      ).toBe(false);
    } finally {
      stopEditing();
    }
  });
});

// ─── Stylebook mode: live styleUpdate + interaction gates ───────────────────────

describe("startCanvasIframe — stylebook mode", () => {
  function stylebookMsg(gen: number, doc: unknown): ParentToIframe {
    return {
      colorScheme: null,
      doc,
      docBase: "http://localhost:3000/",
      gen,
      kind: "render",
      mapperCtx: { ...WIRE_CTX, canvasMode: "stylebook" },
      mode: "stylebook",
      shadowDoc: doc,
      siteStyle: null,
    };
  }

  const sbDoc = (color: string) => ({
    attributes: { class: "sb-root" },
    children: [{ children: ["Hi"], tagName: "p" }],
    style: { "& .element-card-preview p": { color } },
    tagName: "div",
  });

  async function bootStylebook(gen: number) {
    // Scoped style tags land in document.head and outlive the per-test body reset.
    for (const tag of document.head.querySelectorAll("style[data-jx-owner]")) {
      tag.remove();
    }
    const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
    const acks: IframeToParent[] = [];
    pair.parent.onMessage((m) => acks.push(m));
    const container = document.createElement("div");
    document.body.append(container);
    teardown = startCanvasIframe({ channel: pair.iframe, container });
    pair.parent.post(stylebookMsg(gen, sbDoc("red")));
    pair.flush();
    await flush();
    pair.flush();
    return { acks, container, pair };
  }

  const headCss = () =>
    [...document.head.querySelectorAll("style[data-jx-owner]")]
      .map((s) => s.textContent)
      .join("\n");

  test("styleUpdate at the rendered gen reapplies the root style WITHOUT a re-render", async () => {
    const { container, pair } = await bootStylebook(3);
    expect(headCss()).toContain("color: red");
    const rootBefore = container.firstElementChild;

    pair.parent.post({
      gen: 3,
      kind: "styleUpdate",
      style: { "& .element-card-preview p": { color: "blue" } },
    });
    pair.flush();

    expect(headCss()).toContain("color: blue");
    expect(headCss()).not.toContain("color: red");
    // Same DOM root — the whole point: no iframe re-render, no CLS.
    expect(container.firstElementChild).toBe(rootBefore);
  });

  test("a stale-gen styleUpdate is dropped", async () => {
    const { pair } = await bootStylebook(4);
    pair.parent.post({
      gen: 3,
      kind: "styleUpdate",
      style: { "& .element-card-preview p": { color: "blue" } },
    });
    pair.flush();
    expect(headCss()).toContain("color: red");
    expect(headCss()).not.toContain("color: blue");
  });

  test("dblclick does NOT start an inline-edit session on a specimen", async () => {
    const { container, pair } = await bootStylebook(5);
    const p = container.querySelector("p") as HTMLElement;
    p.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    pair.flush();
    await flush();
    const { isEditing } = await import("../src/editor/inline-edit");
    expect(isEditing()).toBe(false);
    expect(p.getAttribute("contenteditable")).toBeNull();
  });

  test("pointer movement posts hover hits but never insertZones; pointerdown never arms a grab", async () => {
    const { acks, container, pair } = await bootStylebook(6);
    const p = container.querySelector("p") as HTMLElement;
    acks.length = 0;

    p.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }));
    pair.flush();
    expect(acks.some((m) => m.kind === "hover")).toBe(true);
    expect(acks.some((m) => m.kind === "insertZones")).toBe(false);

    p.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    container.ownerDocument.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 60, clientY: 10 }),
    );
    pair.flush();
    expect(acks.some((m) => m.kind === "dragOriginate")).toBe(false);
  });

  test("clicks still post hits (the parent decodes them to stylebook tags)", async () => {
    const { acks, container, pair } = await bootStylebook(7);
    const p = container.querySelector("p") as HTMLElement;
    acks.length = 0;
    p.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    pair.flush();
    const hit = acks.find((m) => m.kind === "hit") as { hit: { path: unknown } } | undefined;
    expect(hit?.hit.path).toEqual(["children", 0]);
  });
});
