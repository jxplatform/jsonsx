import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { flush, resetWorkspaceWithTab } from "./harness";
import { activeTab } from "../src/workspace/workspace";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

// ─── Mocks: capture the channel and stub the parent-side resolver ───────────────

interface FakeChannel {
  opts: Record<string, unknown>;
  posts: Record<string, unknown>[];
  deliver: (m: Record<string, unknown>) => void;
}
const channels: FakeChannel[] = [];

void mock.module("../src/canvas/iframe-channel", () => ({
  postMessageChannel: (opts: Record<string, unknown>) => {
    let handler: ((m: Record<string, unknown>) => void) | null = null;
    const rec: FakeChannel = { deliver: (m) => handler?.(m), opts, posts: [] };
    channels.push(rec);
    return {
      dispose: () => {},
      onMessage: (h: (m: Record<string, unknown>) => void) => {
        handler = h;
        return () => {};
      },
      post: (m: Record<string, unknown>) => {
        rec.posts.push(m);
        // Exercise the host's real target (iframe.contentWindow?.postMessage) for coverage; it's a
        // No-op against a detached happy-dom iframe.
        (opts.target as { postMessage: (m: unknown, o: string) => void }).postMessage(
          m,
          opts.targetOrigin as string,
        );
      },
    };
  },
}));

const DEFAULT_RESOLVED = {
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
};
let resolved: Record<string, unknown> = structuredClone(DEFAULT_RESOLVED);
void mock.module("../src/canvas/canvas-live-render", () => ({
  resolveCanvasDocument: () => Promise.resolve(resolved),
}));

const { mountIframeCanvas } = await import("../src/canvas/iframe-host");

beforeEach(() => {
  channels.length = 0;
  document.body.innerHTML = "";
  resolved = structuredClone(DEFAULT_RESOLVED);
});

describe("mountIframeCanvas", () => {
  test("creates one authenticated iframe and posts the resolved doc on ready", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);

    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);

    const iframe = canvasEl.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute("src")).toMatch(
      /\/packages\/studio\/canvas\.html\?parentOrigin=.+&token=.+/,
    );
    expect(channels).toHaveLength(1);
    // Not ready yet → the render is queued, not posted.
    expect(channels[0]!.posts).toHaveLength(0);

    channels[0]!.deliver({ kind: "ready" });
    expect(channels[0]!.posts).toHaveLength(1);
    expect(channels[0]!.posts[0]).toMatchObject({ gen: 1, kind: "render", mode: "design" });
  });

  test("JSON round-trips the doc so non-cloneable values (functions) are dropped", async () => {
    resolved = {
      ...DEFAULT_RESOLVED,
      renderDoc: { children: ["hi"], onClick: () => {}, tagName: "div" },
    };
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, {} as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });

    const posted = channels[0]!.posts[0] as { doc: Record<string, unknown> };
    expect(posted.doc.onClick).toBeUndefined();
    expect(posted.doc.tagName).toBe("div");
    expect(posted.doc.children).toEqual(["hi"]);
  });

  test("reuses a single iframe + channel across re-renders of the same canvas", async () => {
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, {} as never, canvasEl);
    await mountIframeCanvas(2, {} as never, canvasEl);
    expect(canvasEl.querySelectorAll("iframe")).toHaveLength(1);
    expect(channels).toHaveLength(1);
  });

  test("posts immediately (no queue) once the iframe is ready", async () => {
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, {} as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });
    channels[0]!.posts.length = 0;

    await mountIframeCanvas(7, {} as never, canvasEl);
    expect(channels[0]!.posts).toHaveLength(1);
    expect(channels[0]!.posts[0]).toMatchObject({ gen: 7 });
  });

  test("non-ready messages are ignored for the render queue", async () => {
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, {} as never, canvasEl);
    channels[0]!.deliver({ kind: "renderComplete", gen: 1 });
    expect(channels[0]!.posts.some((p) => p.kind === "render")).toBe(false);
  });
});

// ─── Interaction: selection + overlays from posted geometry (Phase 2) ───────────

type Msg = Record<string, unknown>;

async function mountReady(): Promise<HTMLElement> {
  const canvasEl = document.createElement("div");
  document.body.append(canvasEl);
  await mountIframeCanvas(1, {} as never, canvasEl);
  channels[0]!.deliver({ kind: "ready" });
  return canvasEl;
}

describe("iframe canvas interaction", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("a hit selects the node and draws the selection box from the posted rect", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });

    expect(activeTab.value?.session.selection).toEqual(["children", 0]);
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");
    expect(sel.style.left).toBe("10px");
    expect(sel.style.top).toBe("5px");
    expect(sel.style.width).toBe("100px");
    expect(sel.style.height).toBe("20px");
  });

  test("hover draws the hover box unless it coincides with the selection", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    const hover = canvasEl.querySelector(".overlay-hover") as HTMLElement;

    // A different node → hover box shown.
    channels[0]!.deliver({
      hit: { path: ["children", 1], rect: { height: 8, width: 40, x: 2, y: 3 } },
      kind: "hover",
    });
    expect(hover.style.display).toBe("block");
    expect(hover.style.left).toBe("2px");

    // The selected node → suppressed.
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hover",
    });
    expect(hover.style.display).toBe("none");

    // Cleared on leave.
    channels[0]!.deliver({
      hit: { path: ["children", 1], rect: { height: 8, width: 40, x: 2, y: 3 } },
      kind: "hover",
    });
    channels[0]!.deliver({ hit: null, kind: "hover" });
    expect(hover.style.display).toBe("none");
  });

  test("an external selection change asks the iframe to measure it; geometry redraws", async () => {
    const tab = resetWorkspaceWithTab();
    const canvasEl = await mountReady();
    channels[0]!.posts.length = 0; // Drop the initial render post.

    // Selection set from outside the canvas (e.g. the layers panel).
    tab.session.selection = ["children", 2];
    await flush();
    const measure = channels[0]!.posts.find((p) => p.kind === "measure") as Msg | undefined;
    expect(measure).toMatchObject({ kind: "measure", paths: [["children", 2]] });

    const reqId = measure!.reqId as number;
    channels[0]!.deliver({
      hits: [{ path: ["children", 2], rect: { height: 12, width: 30, x: 7, y: 8 } }],
      kind: "geometry",
      reqId,
    });
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");
    expect(sel.style.left).toBe("7px");

    // A stale geometry reply (wrong reqId) is ignored.
    channels[0]!.deliver({ hits: [], kind: "geometry", reqId: reqId - 1 });
    expect(sel.style.display).toBe("block");

    // The matching reqId with no hit clears the box.
    tab.session.selection = ["children", 3];
    await flush();
    const measure2 = channels[0]!.posts.findLast((p) => p.kind === "measure") as Msg;
    channels[0]!.deliver({ hits: [], kind: "geometry", reqId: measure2.reqId as number });
    expect(sel.style.display).toBe("none");
  });

  test("clearing the selection hides the box without a round-trip", async () => {
    const tab = resetWorkspaceWithTab();
    const canvasEl = await mountReady();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");

    tab.session.selection = null;
    await flush();
    expect(sel.style.display).toBe("none");
  });

  test("renderComplete re-measures the current selection", async () => {
    const tab = resetWorkspaceWithTab();
    await mountReady();
    tab.session.selection = ["children", 1];
    await flush();
    channels[0]!.posts.length = 0;

    channels[0]!.deliver({ gen: 1, kind: "renderComplete" });
    expect(channels[0]!.posts.some((p) => p.kind === "measure")).toBe(true);
  });
});
