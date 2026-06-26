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

function renderMsg(gen: number, doc: unknown): ParentToIframe {
  return {
    doc,
    docBase: "http://localhost:3000/",
    gen,
    kind: "render",
    mapperCtx: WIRE_CTX,
    mode: "design",
  };
}

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
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
