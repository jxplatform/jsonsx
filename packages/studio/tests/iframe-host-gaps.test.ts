/**
 * Iframe host gaps — disconnected-host pruning (eval/drag/stylebook posts), the edit-zoom viewport
 * guard, remote-presence measurement + geometry replies, not-ready selection gates, the
 * canvasUrl-changed host rebuild, stylebook message gates (nativeDragEnter, pan, ready re-post),
 * the site-style no-config guard, unknown message kinds, and the toolbar anchor's null fallback.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { canvasPanels } from "../src/store";
import { collabState } from "../src/collab/collab-state";
import { shell } from "../src/shell";
import type { CanvasPanel } from "../src/types";
import type { Tab } from "../src/tabs/tab";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

// ─── Mocks (mirrors iframe-host.test.ts): capture channels, stub the resolver ───

interface FakeChannel {
  opts: Record<string, unknown>;
  posts: Record<string, unknown>[];
  disposed: boolean;
  deliver: (m: Record<string, unknown>) => void;
}
const channels: FakeChannel[] = [];

void mock.module("../src/canvas/iframe-channel", () => ({
  postMessageChannel: (opts: Record<string, unknown>) => {
    let handler: ((m: Record<string, unknown>) => void) | null = null;
    const rec: FakeChannel = { deliver: (m) => handler?.(m), disposed: false, opts, posts: [] };
    channels.push(rec);
    return {
      dispose: () => {
        rec.disposed = true;
      },
      onMessage: (h: (m: Record<string, unknown>) => void) => {
        handler = h;
        return () => {};
      },
      post: (m: Record<string, unknown>) => {
        rec.posts.push(m);
      },
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
  getEditBarAnchorRect,
  hostForCanvas,
  mountIframeCanvas,
  mountStylebookCanvas,
  panToStylebookTag,
  postDragMessage,
  postSiteStyleToLiveHosts,
  postStyleUpdateToStylebookHosts,
  requestCanvasEval,
  setNativeDragEnterHandler,
} = await import("../src/canvas/iframe-host");

const STYLEBOOK_GENERATED = () => ({
  doc: { children: [{ children: ["Hi"], tagName: "h1" }], tagName: "div" } as never,
  pathToTag: new Map([['["children",0]', "h1"]]),
  tagToCardPath: new Map([["h1", ["children", 0] as (string | number)[]]]),
});

async function mountReady(tabId: string | null = null): Promise<HTMLElement> {
  const canvasEl = document.createElement("div");
  document.body.append(canvasEl);
  await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl, null, tabId);
  channels.at(-1)!.deliver({ kind: "ready" });
  return canvasEl;
}

beforeEach(() => {
  channels.length = 0;
  canvasPanels.length = 0;
  document.body.innerHTML = "";
  resetStudioState();
});

// ─── Disconnected-host pruning ───────────────────────────────────────────────

describe("disconnected-host pruning", () => {
  test("requestCanvasEval drops a disconnected host and resolves null", async () => {
    const canvasEl = await mountReady("tab-eval");
    channels.at(-1)!.deliver({ gen: 1, kind: "renderComplete" });
    canvasEl.remove(); // The iframe is no longer connected.
    const result = await requestCanvasEval(
      "tab-eval",
      [{ id: "x", node: { operator: "!" } }],
      null,
    );
    expect(result).toBeNull();
  });

  test("postDragMessage on a disconnected host posts nothing", async () => {
    const canvasEl = await mountReady();
    const host = hostForCanvas(canvasEl)!;
    const { posts } = channels.at(-1)!;
    canvasEl.remove();
    const before = posts.length;
    postDragMessage(host, { dragSeq: 1, kind: "dragEnd" });
    expect(posts.length).toBe(before);
  });

  test("postStyleUpdateToStylebookHosts prunes a disconnected stylebook host", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    mountStylebookCanvas(1, STYLEBOOK_GENERATED(), canvasEl, 800);
    channels.at(-1)!.deliver({ kind: "ready" });
    canvasEl.remove();
    expect(postStyleUpdateToStylebookHosts({ color: "red" })).toBe(0);
  });
});

// ─── Edit-zoom viewport height guard ─────────────────────────────────────────

describe("contentHeight handling", () => {
  test("a canvas element without a parent viewport is guarded", async () => {
    // The canvas element is NOT appended anywhere: no `.canvas-panel-viewport` parent exists.
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    const ch = channels.at(-1)!;
    ch.deliver({ kind: "ready" });
    expect(() => ch.deliver({ fragment: false, height: 700, kind: "contentHeight" })).not.toThrow();
    const iframe = canvasEl.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.height).toBe("700px");
  });
});

// ─── Remote presence measurement ─────────────────────────────────────────────

describe("remote presence", () => {
  test("renderComplete measures peer selections and the geometry reply draws colored boxes", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    collabState(tab).peers = [
      {
        clientId: 7,
        state: {
          focusedPath: tab.documentPath,
          structuralSelection: [["children", 0]],
          user: { color: "#e5484d", login: "octo", name: "Octo Cat" },
        },
      },
      // A peer focused on ANOTHER document is skipped.
      {
        clientId: 8,
        state: {
          focusedPath: "pages/elsewhere.json",
          structuralSelection: [["children", 1]],
          user: { color: "#30a46c", login: "away" },
        },
      },
      // A peer with no structural selection is skipped too.
      {
        clientId: 9,
        state: { focusedPath: tab.documentPath, user: { color: "#888", login: "idle" } },
      },
    ] as never;

    const canvasEl = await mountReady(tab.id);
    const ch = channels.at(-1)!;
    ch.posts.length = 0;
    ch.deliver({ gen: 1, kind: "renderComplete" });

    const measure = ch.posts.findLast((p) => p.kind === "measure") as
      | { paths: (string | number)[][]; reqId: number }
      | undefined;
    expect(measure).toBeDefined();
    expect(measure!.paths).toEqual([["children", 0]]);

    ch.deliver({
      hits: [
        { path: ["children", 0], rect: { height: 12, width: 80, x: 4, y: 6 } },
        // An unknown path (no retained meta) is dropped.
        { path: ["children", 5], rect: { height: 1, width: 1, x: 0, y: 0 } },
      ],
      kind: "geometry",
      reqId: measure!.reqId,
    });
    const box = canvasEl.querySelector(".overlay-presence") as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.cssText).toContain("#e5484d");
    expect(canvasEl.querySelectorAll(".overlay-presence")).toHaveLength(1);
  });

  test("a peer with a MULTI-selection draws one box per path, all under their own name", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    collabState(tab).peers = [
      {
        clientId: 7,
        state: {
          focusedPath: tab.documentPath,
          structuralSelection: [
            ["children", 0],
            ["children", 1],
          ],
          user: { color: "#e5484d", login: "octo", name: "Octo Cat" },
        },
      },
    ] as never;

    const canvasEl = await mountReady(tab.id);
    const ch = channels.at(-1)!;
    ch.posts.length = 0;
    ch.deliver({ gen: 1, kind: "renderComplete" });

    const measure = ch.posts.findLast((p) => p.kind === "measure") as
      | { paths: (string | number)[][]; reqId: number }
      | undefined;
    expect(measure!.paths).toEqual([
      ["children", 0],
      ["children", 1],
    ]);

    ch.deliver({
      hits: [
        { path: ["children", 0], rect: { height: 12, width: 80, x: 4, y: 6 } },
        { path: ["children", 1], rect: { height: 12, width: 80, x: 4, y: 30 } },
      ],
      kind: "geometry",
      reqId: measure!.reqId,
    });
    const boxes = [...canvasEl.querySelectorAll(".overlay-presence")] as HTMLElement[];
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.style.cssText).toContain("#e5484d");
      expect(box.querySelector(".overlay-presence-tag")!.textContent).toBe("Octo Cat");
    }
  });
});

// ─── Not-ready selection gates ───────────────────────────────────────────────

describe("not-ready selection gates", () => {
  test("a selection on a not-yet-ready page host posts no measure", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl); // Never 'ready'.
    const ch = channels.at(-1)!;
    ch.posts.length = 0;
    tab.session.selection = [["children", 0]];
    await flush();
    expect(ch.posts.some((p) => p.kind === "measure")).toBe(false);
  });

  test("a stylebook tag selection on a not-yet-ready host posts no measure", async () => {
    resetWorkspaceWithTab();
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    mountStylebookCanvas(1, STYLEBOOK_GENERATED(), canvasEl, 800); // Never 'ready'.
    const ch = channels.at(-1)!;
    ch.posts.length = 0;
    shell.stylebook.selection = "h1";
    await flush();
    expect(ch.posts.some((p) => p.kind === "measure")).toBe(false);
  });
});

// ─── canvasUrl-change host rebuild ───────────────────────────────────────────

describe("canvasUrl-change rebuild", () => {
  test("a host built with the default URL rebuilds when the platform's loopback URL arrives", async () => {
    const g = globalThis as unknown as { __jxPlatform?: { canvasUrl?: string } | undefined };
    const saved = g.__jxPlatform;
    delete g.__jxPlatform;
    try {
      const canvasEl = document.createElement("div");
      document.body.append(canvasEl);
      await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
      expect(channels).toHaveLength(1);
      const src0 = canvasEl.querySelector("iframe")!.getAttribute("src")!;
      expect(src0.startsWith("/packages/studio/canvas.html?")).toBe(true);

      // The electrobun loopback URL resolves late: the same canvas re-mounts against it.
      g.__jxPlatform = { canvasUrl: "http://127.0.0.1:4242/__studio__/canvas.html" } as never;
      await mountIframeCanvas(2, { tagName: "div" } as never, canvasEl);
      expect(channels).toHaveLength(2);
      expect(channels[0]!.disposed).toBe(true);
      const src1 = canvasEl.querySelector("iframe")!.getAttribute("src")!;
      expect(new URL(src1).origin).toBe("http://127.0.0.1:4242");

      // Re-mounting with the SAME url reuses the rebuilt host.
      await mountIframeCanvas(3, { tagName: "div" } as never, canvasEl);
      expect(channels).toHaveLength(2);
    } finally {
      g.__jxPlatform = saved;
    }
  });
});

// ─── Stylebook message gates ─────────────────────────────────────────────────

describe("stylebook message gates", () => {
  test("nativeDragEnter from a stylebook host never reaches the bridge", async () => {
    const enters: unknown[] = [];
    setNativeDragEnterHandler((host) => enters.push(host));
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    mountStylebookCanvas(1, STYLEBOOK_GENERATED(), canvasEl, 800);
    const ch = channels.at(-1)!;
    ch.deliver({ kind: "ready" });
    ch.deliver({ kind: "nativeDragEnter" });
    expect(enters).toHaveLength(0);
  });

  test("an unknown message kind is ignored", async () => {
    await mountReady();
    expect(() => channels.at(-1)!.deliver({ kind: "definitely-not-a-message" })).not.toThrow();
  });

  test("a stylebook re-render on a ready host posts immediately", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    mountStylebookCanvas(1, STYLEBOOK_GENERATED(), canvasEl, 800);
    const ch = channels.at(-1)!;
    ch.deliver({ kind: "ready" }); // Flushes the pending gen-1 render.
    expect(ch.posts.filter((p) => p.kind === "render")).toHaveLength(1);

    mountStylebookCanvas(2, STYLEBOOK_GENERATED(), canvasEl, 800);
    const renders = ch.posts.filter((p) => p.kind === "render") as { gen: number; mode: string }[];
    expect(renders).toHaveLength(2);
    expect(renders[1]).toMatchObject({ gen: 2, mode: "stylebook" });
  });

  test("panToStylebookTag is inert for a non-stylebook active panel", async () => {
    const canvasEl = await mountReady();
    canvasPanels.push({ canvas: canvasEl, mediaName: "base" } as unknown as CanvasPanel);
    const ch = channels.at(-1)!;
    ch.posts.length = 0;
    panToStylebookTag("h1");
    expect(ch.posts).toHaveLength(0);
  });

  test("panToStylebookTag is inert for a tag without a card", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    mountStylebookCanvas(1, STYLEBOOK_GENERATED(), canvasEl, 800);
    const ch = channels.at(-1)!;
    ch.deliver({ kind: "ready" });
    canvasPanels.push({ canvas: canvasEl, mediaName: "base" } as unknown as CanvasPanel);
    ch.posts.length = 0;
    panToStylebookTag("marquee");
    expect(ch.posts).toHaveLength(0);
  });
});

// ─── Debounced timers: presence watch + insert-zone grace hide ───────────────

describe("debounced timers", () => {
  test("a peer roster change re-measures presence after the debounce", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    const canvasEl = await mountReady(tab.id);
    const ch = channels.at(-1)!;
    ch.deliver({ gen: 1, kind: "renderComplete" });
    ch.posts.length = 0;

    // The presence watcher tracks the roster reactively; the update lands on a 100ms debounce.
    collabState(tab).peers = [
      {
        clientId: 4,
        state: {
          focusedPath: tab.documentPath,
          structuralSelection: [["children", 0]],
          user: { color: "#4f9cf9", login: "late-peer" },
        },
      },
    ] as never;
    await new Promise((resolve) => {
      setTimeout(resolve, 180);
    });
    const measure = ch.posts.findLast((p) => p.kind === "measure") as
      | { paths: (string | number)[][] }
      | undefined;
    expect(measure?.paths).toEqual([["children", 0]]);
    void canvasEl;
  });

  test("the insert '+' hides after the grace delay following an empty zones post", async () => {
    const canvasEl = await mountReady();
    const ch = channels.at(-1)!;
    const zone = {
      edge: "top",
      index: 0,
      parentPath: [],
      rect: { height: 20, width: 150, x: 10, y: 190 },
    };
    ch.deliver({ kind: "insertZones", zones: [zone] });
    const btn = canvasEl.querySelector(".insertion-helper") as HTMLElement;
    expect(btn.style.display).toBe("grid");

    ch.deliver({ kind: "insertZones", zones: null });
    expect(btn.style.display).toBe("grid"); // Grace period — still visible.
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    expect(btn.style.display).toBe("none");
  });
});

// ─── Site-style guard + toolbar anchor fallback ──────────────────────────────

describe("misc guards", () => {
  test("postSiteStyleToLiveHosts without a project config posts nothing", async () => {
    resetStudioState({ projectConfig: null });
    await mountReady();
    const ch = channels.at(-1)!;
    ch.posts.length = 0;
    postSiteStyleToLiveHosts();
    expect(ch.posts).toHaveLength(0);
  });

  test("getEditBarAnchorRect is null when the host has neither snapshot nor selection rect", async () => {
    resetWorkspaceWithTab();
    const canvasEl = await mountReady();
    canvasPanels.push({ canvas: canvasEl, mediaName: "base" } as unknown as CanvasPanel);
    // No edit session, no hit ever measured → nothing to anchor the toolbar to.
    expect(getEditBarAnchorRect()).toBeNull();
  });
});
