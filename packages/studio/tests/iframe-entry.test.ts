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
    pair.parent.post({
      forwardOps: [{ key: "tagName", op: "set-key", path: ["children", 0], value: "h2" }],
      gen: 1,
      kind: "patch",
    });
    pair.flush();
    pair.flush();

    const err = acks.find((m) => m.kind === "patchError") as
      | { gen: number; kind: "patchError"; message: string }
      | undefined;
    expect(err?.gen).toBe(1);
    expect(err?.message).toMatch(/iframe-patch-unsupported-key:tagName/);
  });
});
